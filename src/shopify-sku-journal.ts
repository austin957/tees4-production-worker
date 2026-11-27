import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { WorkerError } from './model.js';
import type { SkuReplacementPlan } from './shopify-sku-execution.js';
import type { SkuBulkResponse } from './shopify-sku-write-adapter.js';
import { shopifySkuSchema } from './store-schema.js';

type Approval = { by: string; source: string; approvedAt: number; expiresAt: number };
export type Dispatch = { id: string; planId: string; approvalSequence: number; claimedAt: number };
type VariantResult = {
  variantId: string;
  observedSku: string | null;
  status: 'AT_TARGET' | 'AT_ORIGINAL' | 'UNEXPECTED' | 'MISSING' | 'DUPLICATE';
};

type JournalEvent =
  | { event: 'approved'; at: number; approvalSequence: number }
  | { event: 'blocked'; at: number; code: string }
  | { event: 'claimed'; at: number; dispatchId: string; approvalSequence: number }
  | { event: 'cancelled_before_send'; at: number; dispatchId: string; code: string }
  | { event: 'shopify_response'; at: number; dispatchId: string; response: SkuBulkResponse }
  | { event: 'dispatch_error' | 'readback_error'; at: number; dispatchId: string; code: string }
  | { event: 'readback'; at: number; dispatchId: string; status: string; variants: VariantResult[] };

export class ShopifySkuJournal {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(run: () => T) => T) {}

  private latestApproval(planId: string) {
    const row = this.db.prepare(
      'SELECT sequence, body FROM shopify_sku_approvals WHERE plan_id = ? ORDER BY sequence DESC LIMIT 1',
    ).get(planId);
    if (!row) throw new WorkerError('SKU_EXECUTION_APPROVAL_REQUIRED', 'A separate SKU execution approval is required.');
    return { sequence: Number(row.sequence), ...JSON.parse(row.body as string) as Approval };
  }

  approve(plan: SkuReplacementPlan, approval: Approval, assertEvidence: () => void) {
    return this.transaction(() => {
      assertEvidence();
      this.db.exec(shopifySkuSchema);
      this.assertNoDispatch(plan);
      const body = JSON.stringify(plan);
      this.db.prepare(`
        INSERT INTO shopify_sku_plans SELECT ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM shopify_sku_plans WHERE id = ?)
      `).run(plan.id, plan.bindingId, body, plan.id);
      if (JSON.stringify(this.getPlan(plan.id)) !== body) {
        throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'The stored plan differs from the reviewed plan.');
      }
      const { lastInsertRowid } = this.db.prepare('INSERT INTO shopify_sku_approvals(plan_id, body) VALUES (?, ?)')
        .run(plan.id, JSON.stringify(approval));
      const approvalSequence = Number(lastInsertRowid);
      this.append(plan.id, { event: 'approved', at: approval.approvedAt, approvalSequence });
      return { planId: plan.id, approvalSequence, ...approval };
    });
  }

  getPlan(planId: string): SkuReplacementPlan {
    const initialized = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'shopify_sku_plans'").get();
    const row = initialized && this.db.prepare('SELECT body FROM shopify_sku_plans WHERE id = ?').get(planId);
    if (!row) throw new WorkerError('SKU_EXECUTION_APPROVAL_REQUIRED', 'No separately approved plan matches that ID.');
    return JSON.parse(row.body as string) as SkuReplacementPlan;
  }

  assertApproval(planId: string, sequence: number, now: number): void {
    const approval = this.latestApproval(planId);
    if (approval.sequence !== sequence || now < approval.approvedAt || now >= approval.expiresAt) {
      throw new WorkerError('SKU_EXECUTION_APPROVAL_CHANGED', 'SKU execution approval has expired or changed.');
    }
  }

  assertNoDispatch(plan: SkuReplacementPlan): void {
    if (this.db.prepare(`
      SELECT id FROM shopify_sku_dispatches WHERE shop_id = ? AND product_id = ? AND cancelled_before_send = 0
    `).get(plan.shopId, plan.productId)) {
      throw new WorkerError('SKU_EXECUTION_ALREADY_CLAIMED', 'A dispatch already exists for this Shopify product. Use read-only reconciliation.');
    }
  }

  claim(plan: SkuReplacementPlan, sequence: number, now: number, assertEvidence: () => void): Dispatch {
    return this.transaction(() => {
      this.assertNoDispatch(plan);
      assertEvidence();
      this.assertApproval(plan.id, sequence, now);
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO shopify_sku_dispatches (id, plan_id, approval_sequence, shop_id, product_id, claimed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, plan.id, sequence, plan.shopId, plan.productId, now);
      this.append(plan.id, { event: 'claimed', at: now, dispatchId: id, approvalSequence: sequence });
      return { id, planId: plan.id, approvalSequence: sequence, claimedAt: now };
    });
  }

  cancelBeforeSend(dispatch: Dispatch, now: number, code: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE shopify_sku_dispatches SET cancelled_before_send = 1 WHERE id = ?').run(dispatch.id);
      this.append(dispatch.planId, { event: 'cancelled_before_send', at: now, dispatchId: dispatch.id, code });
    });
  }

  dispatchFor(planId: string): Dispatch {
    const row = this.db.prepare(`
      SELECT id, approval_sequence, claimed_at FROM shopify_sku_dispatches WHERE plan_id = ? AND cancelled_before_send = 0
    `).get(planId);
    if (!row) throw new WorkerError('SKU_EXECUTION_NOT_DISPATCHED', 'No SKU dispatch exists for this plan.');
    return { id: row.id as string, planId, approvalSequence: Number(row.approval_sequence), claimedAt: Number(row.claimed_at) };
  }

  append(planId: string, event: JournalEvent): void {
    this.db.prepare('INSERT INTO shopify_sku_events(plan_id, body) VALUES (?, ?)').run(planId, JSON.stringify(event));
  }

  inspect(planId: string) {
    const plan = this.getPlan(planId);
    const approvals = this.db.prepare('SELECT sequence, body FROM shopify_sku_approvals WHERE plan_id = ? ORDER BY sequence')
      .all(planId).map(row => ({ sequence: Number(row.sequence), ...JSON.parse(row.body as string) as Approval }));
    const events = this.db.prepare('SELECT body FROM shopify_sku_events WHERE plan_id = ? ORDER BY sequence')
      .all(planId).map(row => JSON.parse(row.body as string) as JournalEvent);
    return { plan, approvals, events };
  }
}
