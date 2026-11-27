import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { integer, object, onlyKeys } from './config.js';
import { databaseIdentity, durabilityStatus, sqliteBackupTo, verifyDurability } from './mockupify-durability.js';
import type { GarmentCompletionTarget, SheetsCompletionAdapter } from './garment-completion.js';
import type { MockupifyPreparationRecord } from './mockupify-preparation.js';
import { assertMockupifyOperationReview, mockupifyDigest, unresolvedMockupifyReview } from './mockupify-writer-model.js';
import type { MockupifyClaim, MockupifyJournal, SupervisedMockupifyPlan } from './mockupify-writer-model.js';
import { parseExportEvidence } from './mockupify.js';
import type { ExportJob, ExportPlan } from './mockupify.js';
import { completionAction, isProduction, WorkerError } from './model.js';
import { assertExportWindow, assertSkuWindow, ProductionWriteDeferred } from './production-schedule.js';
import type { BindingAssignment, BindingEvent, BindingReviewEvent, ProductBinding } from './product-bindings.js';
import type { ProductRead } from './shopify-readonly.js';
import { existingSku, parseShopifyCatalog, resolveProduct } from './shopify-skus.js';
import type { InitialSkuTarget, ShopifyProduct, ShopifyProductBinding, ShopifySkuAdapter } from './shopify-skus.js';
import { ShopifySkuJournal } from './shopify-sku-journal.js';
import { workerSchema } from './store-schema.js';
import type { Artwork, Details, GarmentCompletion, Job, Mode, StageResult, Workflow, WriteAction } from './model.js';

export interface Claim {
  job: Job;
  token: string;
}

interface Effect {
  details: Details;
  reused: boolean;
}

function identity(artwork: Artwork, mode: Mode, workflow: Workflow): string {
  const completion = workflow.stages.some(stage => stage.kind === 'action' && stage.action === completionAction);
  return JSON.stringify(isProduction(artwork)
    ? [completion ? 'production-completion' : 'production', mode, artwork.artworkSku]
    : [mode, artwork.artworkId, artwork.sku]);
}

export class Store {
  private readonly db: DatabaseSync;
  readonly shopifySkuJournal: ShopifySkuJournal;
  private readonly path: string;
  private readonly openedIdentity: string | null;

  constructor(path: string, { readOnly = false, existing = false }: { readOnly?: boolean; existing?: boolean } = {}) {
    this.path = path === ':memory:' ? path : resolve(path);
    let db: DatabaseSync | undefined;
    try {
      const before = databaseIdentity(this.path);
      if (existing && !before) throw new Error('Supply the path to an existing SQLite database.');
      if (!readOnly && !existing && path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
      const filename = existing ? pathToFileURL(this.path).href + (readOnly ? '?mode=ro' : '?mode=rw') : this.path;
      db = new DatabaseSync(filename, { readOnly, timeout: 5000 });
      this.db = db;
      const after = databaseIdentity(this.path);
      this.openedIdentity = before === null || before === after ? after : null;
      if (!readOnly) {
        if (!existing) db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = FULL');
        if (!existing) db.exec(workerSchema);
      }
      this.shopifySkuJournal = new ShopifySkuJournal(db, run => this.transaction(run));
    } catch (error) {
      db?.close();
      throw new WorkerError('DATABASE_OPEN', `Could not initialize the worker database: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveMockupifyPreparation(record: MockupifyPreparationRecord, now: number): { reused: boolean } {
    return this.transaction(() => {
      const binding = this.db.prepare(`
        SELECT id FROM product_bindings WHERE spreadsheet_id = ? AND (row_number = ? OR product_sku = ?)
          AND status IN ('proposed', 'approved')
      `).get(record.spreadsheetId, record.sourceRow, record.productSku);
      if (binding) throw new WorkerError('MOCKUPIFY_PREPARATION_CONFLICT', 'An active binding already uses this row or Product SKU.');
      const body = JSON.stringify(record);
      const result = this.db.prepare(`
        INSERT INTO mockupify_export_preparations (correlation_id, spreadsheet_id, product_sku, created_at, body)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(spreadsheet_id, product_sku) DO NOTHING
      `).run(record.correlationId, record.spreadsheetId, record.productSku, now, body);
      if (result.changes === 1) return { reused: false };
      const existing = this.db.prepare(`
        SELECT body FROM mockupify_export_preparations WHERE spreadsheet_id = ? AND product_sku = ?
      `).get(record.spreadsheetId, record.productSku);
      if (existing?.body !== body) {
        throw new WorkerError('MOCKUPIFY_PREPARATION_CONFLICT', 'A different preparation is already recorded for this Product SKU.');
      }
      return { reused: true };
    });
  }

  // Snapshot the entire database, including committed WAL contents and binding history.
  async backupTo(path: string): Promise<void> {
    return sqliteBackupTo(this.db, path);
  }

  mockupifyDurabilityStatus() {
    return durabilityStatus(this.db, this.path, this.openedIdentity);
  }

  hasVerifiedMockupifyDurability(): boolean {
    return this.mockupifyDurabilityStatus().admitted;
  }

  verifyMockupifyDurability(directory: string) {
    return verifyDurability(this.db, this.path, this.openedIdentity, directory, path => this.backupTo(path));
  }

  getMockupifyJournal(id: string): MockupifyJournal {
    const row = this.db.prepare('SELECT body FROM mockupify_writer_journal WHERE correlation_id = ?').get(id);
    if (!row) throw new WorkerError('MOCKUPIFY_JOURNAL_NOT_FOUND', 'No supervised journal matches that correlation ID.');
    return JSON.parse(row.body as string) as MockupifyJournal;
  }

  inspectMockupifyJournal(id: string) {
    return {
      journal: this.getMockupifyJournal(id),
      history: this.db.prepare('SELECT body FROM mockupify_writer_events WHERE correlation_id = ? ORDER BY sequence')
        .all(id).map(row => JSON.parse(row.body as string) as unknown),
    };
  }

  registerMockupifyPlan(plan: SupervisedMockupifyPlan, pendingAt?: number): MockupifyJournal {
    return this.transaction(() => {
      const { correlationId, productSku } = plan.correlation;
      this.assertMockupifyBindingClear(plan);
      const journal: MockupifyJournal = {
        plan, ...(pendingAt === undefined ? {} : { registrationState: 'pending_review' as const }),
        revision: 0, batchId: null, designId: null, exportId: null, exportTerminal: false,
        exportStatus: 'unobserved', observedProductGids: [], shopifyProductGid: null, claims: {},
      };
      const result = this.db.prepare(`
        INSERT INTO mockupify_writer_journal (correlation_id, product_sku, body) VALUES (?, ?, ?)
        ON CONFLICT(correlation_id) DO NOTHING
      `).run(correlationId, productSku, JSON.stringify(journal));
      if (result.changes === 1) {
        if (pendingAt !== undefined) {
          this.db.prepare('INSERT INTO mockupify_writer_events (correlation_id, body) VALUES (?, ?)')
            .run(correlationId, JSON.stringify({ event: 'pending_review_registered', at: pendingAt,
              unresolved: unresolvedMockupifyReview(plan.review) }));
        }
        return journal;
      }
      const existing = this.getMockupifyJournal(correlationId);
      if ((existing.registrationState === 'pending_review') !== (pendingAt !== undefined) ||
        mockupifyDigest(existing.plan) !== mockupifyDigest(plan)) {
        throw new WorkerError('MOCKUPIFY_JOURNAL_CONFLICT', 'A different supervised plan already owns this Product SKU.');
      }
      return existing;
    });
  }

  recordMockupifyBatchReview(journal: MockupifyJournal, evidence: string, at: number): MockupifyJournal {
    return this.transaction(() => {
      const current = this.getMockupifyJournal(journal.plan.correlation.correlationId);
      const { plan } = current;
      const recorded = plan.review.exclusiveBatchControlEvidence;
      if (current.revision !== journal.revision || current.registrationState !== 'pending_review' ||
        Object.keys(current.claims).length || (recorded !== null && recorded !== evidence)) {
        throw new WorkerError('MOCKUPIFY_BATCH_REVIEW_CONFLICT', 'Batch review cannot replace recorded evidence or change a claimed plan.');
      }
      if (!evidence.trim()) {
        throw new WorkerError('MOCKUPIFY_PENDING_REVIEW', 'Supply verified exclusive batch control evidence.');
      }
      this.assertMockupifyBindingClear(plan);
      if (recorded === evidence) return current;
      return this.saveMockupifyJournal({
        ...current, plan: { ...plan, review: { ...plan.review, exclusiveBatchControlEvidence: evidence } },
      }, { event: 'batch_review_recorded', at, exclusiveBatchControlEvidence: evidence });
    });
  }

  finalizeMockupifyPlan(plan: SupervisedMockupifyPlan, at: number, revision: number): MockupifyJournal {
    return this.transaction(() => {
      const current = this.getMockupifyJournal(plan.correlation.correlationId);
      if (current.revision !== revision || current.registrationState !== 'pending_review' || current.claims.start_export ||
        Object.values(current.claims).some(claim => claim.state !== 'acknowledged' && claim.state !== 'recovered') ||
        (current.batchId !== null) !== !!current.claims.create_batch ||
        (current.designId !== null) !== !!current.claims.upload_design || current.exportId !== null ||
        current.exportStatus !== 'unobserved' || current.observedProductGids.length) {
        throw new WorkerError('MOCKUPIFY_FINALIZATION_CONFLICT', 'Only a pending plan with settled batch and design claims can be finalized.');
      }
      if (unresolvedMockupifyReview(plan.review).length) {
        throw new WorkerError('MOCKUPIFY_FINALIZATION_EVIDENCE', 'Finalization requires all outstanding review evidence.');
      }
      const expected = structuredClone(current.plan);
      expected.review.product.descriptionHtml ??= plan.review.product.descriptionHtml;
      expected.review.product.title ??= plan.review.product.title;
      expected.review.product.variants ??= plan.review.product.variants;
      expected.review.exclusiveBatchControlEvidence ??= plan.review.exclusiveBatchControlEvidence;
      expected.review.publicationSafety ??= plan.review.publicationSafety;
      if (plan.review.initialDescriptionEvidence !== undefined) {
        expected.review.initialDescriptionEvidence ??= plan.review.initialDescriptionEvidence;
      }
      if (plan.review.expectedInitialDescription !== undefined) {
        expected.review.expectedInitialDescription ??= plan.review.expectedInitialDescription;
      }
      if (plan.review.variantOptionsEvidence !== undefined) {
        expected.review.variantOptionsEvidence ??= plan.review.variantOptionsEvidence;
      }
      if (mockupifyDigest(expected) !== mockupifyDigest(plan)) {
        throw new WorkerError('MOCKUPIFY_FINALIZATION_CONFLICT', 'Finalization changed recorded source, artwork, catalog or review values.');
      }
      this.assertMockupifyBindingClear(plan);
      return this.saveMockupifyJournal({ ...current, plan, registrationState: 'finalized' },
        { event: 'plan_finalized', at, resolved: unresolvedMockupifyReview(current.plan.review) });
    });
  }

  private assertMockupifyBindingClear(plan: SupervisedMockupifyPlan): void {
    const { spreadsheetId, sourceRow, productSku } = plan.correlation;
    const existing = this.db.prepare(`
      SELECT id FROM product_bindings WHERE spreadsheet_id = ? AND (row_number = ? OR product_sku = ?)
        AND status IN ('proposed', 'approved')
    `).get(spreadsheetId, sourceRow, productSku);
    if (existing) throw new WorkerError('MOCKUPIFY_BINDING_CONFLICT', 'An active Shopify binding already uses this row or Product SKU.');
  }

  updateMockupifyJournal(journal: MockupifyJournal, event: unknown): MockupifyJournal {
    return this.transaction(() => this.saveMockupifyJournal(journal, event));
  }

  holdMockupifyPublication(id: string, event: unknown): MockupifyJournal {
    return this.transaction(() => {
      const journal = this.getMockupifyJournal(id);
      return this.saveMockupifyJournal({
        ...journal, publicationObserved: true, exportStatus: 'held', shopifyProductGid: null,
      }, event);
    });
  }

  private saveMockupifyJournal(journal: MockupifyJournal, event: unknown): MockupifyJournal {
    const id = journal.plan.correlation.correlationId;
    const next = { ...journal, revision: journal.revision + 1 };
    const result = this.db.prepare(`
      UPDATE mockupify_writer_journal SET batch_id = ?, design_id = ?, export_id = ?, body = ?
      WHERE correlation_id = ? AND json_extract(body, '$.revision') = ?
    `).run(next.batchId, next.designId, next.exportId, JSON.stringify(next), id, journal.revision);
    if (result.changes !== 1) {
      throw new WorkerError('MOCKUPIFY_JOURNAL_CHANGED', 'The supervised journal changed. Inspect or reconcile the existing claim.');
    }
    this.db.prepare('INSERT INTO mockupify_writer_events (correlation_id, body) VALUES (?, ?)')
      .run(id, JSON.stringify(event));
    return next;
  }

  claimMockupifyOperation(journal: MockupifyJournal, claim: MockupifyClaim, remoteActive: number[], check: () => void) {
    return this.transaction(() => {
      const operation = claim.request.operation;
      const current = this.getMockupifyJournal(journal.plan.correlation.correlationId);
      if (current.revision !== journal.revision || current.claims[operation]) {
        throw new WorkerError('MOCKUPIFY_ALREADY_CLAIMED', 'An existing claim or journal change requires inspection before dispatch.');
      }
      assertMockupifyOperationReview(current, operation);
      this.assertMockupifyBindingClear(current.plan);
      const newExport = operation === 'start_export';
      if (newExport) {
        const active = this.db.prepare(`
          SELECT export_id FROM mockupify_writer_journal
          WHERE json_type(body, '$.claims.start_export') IS NOT NULL
            AND json_extract(body, '$.exportTerminal') = 0
        `).all();
        const seen = new Set(active.map(row => row.export_id));
        if (active.length + new Set(remoteActive.filter(id => !seen.has(id))).size >= 2) {
          throw new WorkerError('MOCKUPIFY_EXPORT_CAPACITY', 'Mockupify has no verified free export slot.');
        }
      }
      check();
      const budgetSequence = this.takeMockupifyRequest(claim.claimedAt, newExport);
      const claimed = { ...claim, budgetSequence };
      const next = { ...current, claims: { ...current.claims, [operation]: claimed } };
      return this.saveMockupifyJournal(next, { event: 'claim', ...claimed });
    });
  }

  abortUnsentMockupifyOperation(journal: MockupifyJournal, priorClaims: MockupifyJournal['claims'],
    claim: MockupifyClaim, now: number): void {
    this.transaction(() => {
      const budgetSequence = journal.claims[claim.request.operation]?.budgetSequence;
      if (budgetSequence === undefined) throw new WorkerError('MOCKUPIFY_JOURNAL_CHANGED', 'The dispatch claim is missing.');
      this.db.prepare('DELETE FROM mockupify_request_budget WHERE sequence = ?').run(budgetSequence);
      this.saveMockupifyJournal({ ...journal, claims: priorClaims },
        { event: 'aborted_before_send', operation: claim.request.operation, at: now });
    });
  }

  private takeMockupifyRequest(now: number, newExport: boolean): number {
    const retryAfter = this.db.prepare('SELECT until FROM mockupify_retry_after WHERE id = 1').get()?.until as number | undefined;
    if (retryAfter !== undefined && now < retryAfter) {
      throw new WorkerError('MOCKUPIFY_RATE_LIMITED', 'The account is waiting for the Mockupify Retry-After interval.', true);
    }
    this.db.prepare('DELETE FROM mockupify_request_budget WHERE at <= ?').run(now - 3_600_000);
    const budget = this.db.prepare('SELECT COUNT(*) AS requests, COALESCE(SUM(new_export), 0) AS exports FROM mockupify_request_budget').get();
    if (Number(budget?.requests) >= 1200 || (newExport && Number(budget?.exports) >= 60)) {
      throw new WorkerError('MOCKUPIFY_RATE_LIMITED', 'The supervised writer reached the hourly Mockupify request budget.', true);
    }
    return Number(this.db.prepare('INSERT INTO mockupify_request_budget (at, new_export) VALUES (?, ?)').run(now, Number(newExport)).lastInsertRowid);
  }

  reserveMockupifyRead(now: number): void {
    this.transaction(() => this.takeMockupifyRequest(now, false));
  }

  deferMockupifyRequests(until: number): void {
    this.db.prepare(`
      INSERT INTO mockupify_retry_after (id, until) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET until = max(until, excluded.until)
    `).run(until);
  }

  listProductBindings() {
    return this.db.prepare('SELECT body FROM product_bindings ORDER BY created_at, id').all().map(row => {
      const { shopifySnapshot, ...binding } = JSON.parse(row.body as string) as ProductBinding;
      return { ...binding, variantCount: shopifySnapshot.variants.length };
    });
  }

  getProductBinding(id: string): ProductBinding {
    const row = this.db.prepare('SELECT body FROM product_bindings WHERE id = ?').get(id);
    if (!row) throw new WorkerError('BINDING_NOT_FOUND', 'No product binding matches that ID.');
    return JSON.parse(row.body as string) as ProductBinding;
  }

  recordPostHextomAlerts(binding: ProductBinding, alertIds: readonly string[], now: number) {
    return this.transaction(() => {
      if (this.getProductBinding(binding.id).status !== binding.status) {
        throw new WorkerError('BINDING_REVIEW_CONFLICT', 'The binding status changed during the report. Run it again.');
      }
      const insert = this.db.prepare(`
        INSERT INTO post_hextom_alerts (id, binding_id, first_seen_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING
      `);
      const get = this.db.prepare('SELECT first_seen_at FROM post_hextom_alerts WHERE id = ?');
      return [...new Set(alertIds)].map(id => {
        const created = insert.run(id, binding.id, now).changes === 1;
        const firstSeenAt = created ? now : get.get(id)!.first_seen_at as number;
        return { id, created, firstSeenAt };
      });
    });
  }

  inspectProductBinding(id: string) {
    return this.transaction(() => ({
      binding: this.getProductBinding(id),
      history: this.db.prepare('SELECT body FROM product_binding_events WHERE binding_id = ? ORDER BY sequence').all(id)
        .map(row => JSON.parse(row.body as string) as BindingEvent),
    }));
  }

  private appendBindingEvent(id: string, event: BindingEvent): void {
    this.db.prepare('INSERT INTO product_binding_events (binding_id, body) VALUES (?, ?)').run(id, JSON.stringify(event));
  }

  createProductBinding(assignment: BindingAssignment, by: string, shopifySnapshot: ProductRead, at: number): ProductBinding {
    return this.transaction(() => {
      const { spreadsheetId, rowNumber, productSku, shopId, productId } = assignment;
      const conflict = this.db.prepare(`
        SELECT id FROM product_bindings WHERE status IN ('proposed', 'approved')
          AND ((spreadsheet_id = ? AND row_number = ?) OR (shop_id = ? AND product_id = ?)
            OR (spreadsheet_id = ? AND product_sku = ?))
      `).get(spreadsheetId, rowNumber, shopId, productId, spreadsheetId, productSku);
      if (conflict) throw new WorkerError('BINDING_ASSIGNMENT_CONFLICT', 'An active binding already uses this row, Shopify product or Product SKU.');
      const binding: ProductBinding = {
        ...assignment, id: randomUUID(), status: 'proposed', createdAt: at, updatedAt: at, shopifySnapshot, confirmation: null,
      };
      this.db.prepare(`
        INSERT INTO product_bindings (id, spreadsheet_id, row_number, product_sku, shop_id, product_id, status, created_at, body)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(binding.id, spreadsheetId, rowNumber, productSku, shopId, productId, binding.status, at, JSON.stringify(binding));
      this.appendBindingEvent(binding.id, { event: 'proposed', at, by, from: null, to: 'proposed' });
      return binding;
    });
  }

  recordProductBindingReview(id: string, review: BindingReviewEvent) {
    return this.transaction(() => {
      const binding = this.getProductBinding(id);
      const from = binding.status;
      const expected = review.event === 'revalidated' || ('review' in review && review.review === 'recheck') ? 'approved' : 'proposed';
      if (from !== expected) throw new WorkerError('BINDING_REVIEW_CONFLICT', 'The binding no longer has the status required for this review.');
      if (review.event === 'approved') binding.confirmation = { by: review.by, at: review.at, source: review.source };
      if (review.event !== 'verification_failed' && review.event !== 'revalidated') {
        binding.status = review.event;
        binding.updatedAt = review.at;
        this.db.prepare('UPDATE product_bindings SET status = ?, body = ? WHERE id = ?')
          .run(binding.status, JSON.stringify(binding), id);
      }
      const event = { ...review, from, to: binding.status };
      this.appendBindingEvent(id, event);
      return { binding, event };
    });
  }

  private load(id: string): Job {
    const row = this.db.prepare('SELECT body FROM jobs WHERE id = ?').get(id);
    if (!row) throw new WorkerError('JOB_NOT_FOUND', 'No job matches that ID.');
    return JSON.parse(row.body as string) as Job;
  }

  get(id: string): Job {
    return this.load(id);
  }

  list(): Job[] {
    return this.db.prepare('SELECT body FROM jobs ORDER BY created_at, id').all()
      .map(row => JSON.parse(row.body as string) as Job);
  }

  submit(artwork: Artwork, workflow: Workflow, mode: Mode, now: number): { job: Job; duplicate: boolean } {
    return this.transaction(() => {
      const key = identity(artwork, mode, workflow);
      const row = this.db.prepare('SELECT body FROM jobs WHERE identity = ?').get(key);
      if (row) {
        const job = JSON.parse(row.body as string) as Job;
        if (JSON.stringify(job.artwork) !== JSON.stringify(artwork) || JSON.stringify(job.workflow) !== JSON.stringify(workflow)) {
          throw new WorkerError('JOB_CONFLICT', 'This artwork and SKU already have a job in this mode with different input or workflow.');
        }
        return { job, duplicate: true };
      }
      const job: Job = {
        id: randomUUID(), artwork, workflow, mode, status: 'queued', nextStage: 0, failures: 0,
        results: [], history: [{ at: now, event: 'submitted' }], createdAt: now, updatedAt: now, availableAt: now,
      };
      this.db.prepare('INSERT INTO jobs (id, identity, status, available_at, created_at, body) VALUES (?, ?, ?, ?, ?, ?)')
        .run(job.id, key, job.status, job.availableAt, job.createdAt, JSON.stringify(job));
      return { job, duplicate: false };
    });
  }

  private save(job: Job, now: number, token: string | null = null, lease: number | null = null): Job {
    job.updatedAt = now;
    this.db.prepare('UPDATE jobs SET status = ?, available_at = ?, claim_token = ?, lease_until = ?, body = ? WHERE id = ?')
      .run(job.status, job.availableAt, token, lease, JSON.stringify(job), job.id);
    return job;
  }

  claim(now: number): Claim | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT body FROM jobs
        WHERE (status IN ('queued', 'retry_wait') AND available_at <= ?)
           OR (status = 'running' AND lease_until <= ?)
        ORDER BY available_at, created_at, id LIMIT 1
      `).get(now, now);
      if (!row) return undefined;
      const job = JSON.parse(row.body as string) as Job;
      const stageId = job.workflow.stages[job.nextStage]!.id;
      if (job.status === 'running') job.history.push({ at: now, event: 'lease_recovered', stageId });
      job.status = 'running';
      job.history.push({ at: now, event: 'stage_started', stageId });
      const token = randomUUID();
      return { token, job: this.save(job, now, token, now + job.workflow.leaseMs) };
    });
  }

  private settle(claim: Claim, now: number, update: (job: Job) => void, keepLease = false): Job | undefined {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT body, lease_until FROM jobs WHERE id = ? AND claim_token = ? AND lease_until > ?')
        .get(claim.job.id, claim.token, now);
      if (!row) return undefined;
      const job = JSON.parse(row.body as string) as Job;
      update(job);
      return keepLease ? this.save(job, now, claim.token, row.lease_until as number) : this.save(job, now);
    });
  }

  checkpointGarment(claim: Claim, outcome: GarmentCompletion, now: number): boolean {
    return this.settle(claim, now, job => {
      job.garmentCompletions = [...(job.garmentCompletions ?? []).filter(row => row.sourceRow !== outcome.sourceRow), outcome]
        .sort((left, right) => left.sourceRow - right.sourceRow);
    }, true) !== undefined;
  }

  private advance(job: Job, result: StageResult, now: number): void {
    job.results.push(result);
    job.history.push({ at: now, event: result.outcome, stageId: result.stageId });
    job.nextStage += 1;
    job.failures = 0;
    job.availableAt = now;
    job.status = 'queued';
    if (job.nextStage === job.workflow.stages.length) {
      const needsReview = job.results.some(stage => stage.skuAssignments?.some(variant => variant.review))
        || job.garmentCompletions?.some(garment => garment.status === 'needs_review');
      job.status = needsReview ? 'needs_review' : 'completed';
      job.history.push({ at: now, event: job.status });
    }
  }

  finish(claim: Claim, result: StageResult, now: number): Job | undefined {
    return this.settle(claim, now, job => this.advance(job, result, now));
  }

  pause(claim: Claim, stageId: string, now: number): Job | undefined {
    return this.settle(claim, now, job => {
      job.status = 'awaiting_approval';
      job.history.push({ at: now, event: 'approval_required', stageId });
    });
  }

  approve(id: string, stageId: string, approver: string, now: number): Job {
    return this.transaction(() => {
      const job = this.load(id);
      if (job.results.some(result => result.stageId === stageId && result.outcome === 'approved')) return job;
      const stage = job.workflow.stages[job.nextStage];
      if (job.status !== 'awaiting_approval' || stage?.kind !== 'approval' || stage.id !== stageId) {
        throw new WorkerError('APPROVAL_MISMATCH', 'This job is not awaiting approval for that stage.');
      }
      this.advance(job, { stageId, outcome: 'approved', details: { approver } }, now);
      return this.save(job, now);
    });
  }

  defer(claim: Claim, stageId: string, error: WorkerError, retryAt: number, now: number): Job | undefined {
    return this.settle(claim, now, job => {
      job.status = 'retry_wait';
      job.availableAt = retryAt;
      job.history.push({ at: now, event: 'write_deferred', stageId, code: error.code, message: error.message });
    });
  }

  fail(claim: Claim, stageId: string, error: WorkerError, now: number): Job | undefined {
    return this.settle(claim, now, job => {
      job.failures += 1;
      const retry = error.retryable && job.failures < job.workflow.maxAttempts;
      job.status = retry ? 'retry_wait' : 'failed';
      if (!retry) {
        for (const garment of job.garmentCompletions ?? []) {
          if (garment.status === 'retry_wait') garment.status = 'failed';
        }
      }
      job.availableAt = now + (retry ? job.workflow.retryDelayMs : 0);
      job.history.push({
        at: now, event: retry ? 'retry_scheduled' : 'failed', stageId, code: error.code, message: error.message,
      });
    });
  }

  importSheetFixtures(input: unknown): number {
    if (!Array.isArray(input) || !input.length) {
      throw new WorkerError('INVALID_SHEET_ROW', 'Supply one or more simulated Master Input rows.');
    }
    return this.transaction(() => {
      let imported = 0;
      const seen = new Set<number>();
      for (const entry of input as unknown[]) {
        const row = object(entry, 'Sheet fixture row');
        onlyKeys(row, ['rowNumber', 'cells'], 'Sheet fixture row');
        const rowNumber = integer(row.rowNumber, 'Sheet fixture row number', 1, Number.MAX_SAFE_INTEGER);
        if (seen.has(rowNumber)) throw new WorkerError('DUPLICATE_SHEET_ROW', 'The fixture repeats a physical row number.');
        seen.add(rowNumber);
        if (!Array.isArray(row.cells) || row.cells.length < 11) {
          throw new WorkerError('INVALID_SHEET_ROW', 'Fixture rows must contain positional cells A through K.');
        }
        const contents = JSON.stringify(row.cells);
        const existing = this.db.prepare('SELECT fixture FROM master_input_fixtures WHERE row_number = ?').get(rowNumber);
        if (existing) {
          if (existing.fixture !== contents) throw new WorkerError('FIXTURE_CONFLICT', 'An existing physical sheet row differs from the fixture.');
          continue;
        }
        this.db.prepare('INSERT INTO master_input_fixtures (row_number, cells, fixture) VALUES (?, ?, ?)')
          .run(rowNumber, contents, contents);
        imported += 1;
      }
      return imported;
    });
  }

  private inspectGarment(target: GarmentCompletionTarget, expectedProductId?: string): GarmentCompletion {
    const { sourceRow, productSku, artworkSku } = target;
    const report = { sourceRow, productSku };
    const row = this.db.prepare(`
      SELECT json_extract(cells, '$[8]') AS completion, json_type(cells, '$[8]') AS completion_type
      FROM master_input_fixtures
      WHERE row_number = ? AND json_extract(cells, '$[7]') = ? AND json_extract(cells, '$[10]') = ?
    `).get(sourceRow, productSku, artworkSku);
    if (!row) return { ...report, status: 'needs_review', code: 'SHEET_ROW_MISMATCH' };
    const duplicate = this.db.prepare(`
      SELECT row_number FROM master_input_fixtures WHERE json_extract(cells, '$[7]') = ? AND row_number <> ? LIMIT 1
    `).get(productSku, sourceRow);
    if (duplicate) return { ...report, status: 'needs_review', code: 'DUPLICATE_PRODUCT_SKU' };

    if (row.completion === 'Yes') return { ...report, status: 'already_completed' };
    if (row.completion_type !== 'null' && row.completion !== '') {
      return { ...report, status: 'needs_review', code: 'EXISTING_COMPLETION_VALUE' };
    }

    const product = resolveProduct(this.findShopifyBindings(productSku), artworkSku);
    const bound = { ...report, productId: product.id };
    if ((expectedProductId !== undefined && product.id !== expectedProductId)
      || (product.sourceRow !== undefined && product.sourceRow !== sourceRow)) {
      return { ...bound, status: 'needs_review', code: 'PRODUCT_BINDING_CONFLICT' };
    }
    const variants = this.db.prepare('SELECT id, sku FROM shopify_variants WHERE product_id = ? ORDER BY id').all(product.id);
    if (!variants.length) return { ...bound, status: 'needs_review', code: 'VARIANTS_NOT_FOUND' };

    const unexpected = variants.filter(variant => variant.sku !== null && variant.sku !== productSku);
    if (unexpected.length) {
      return { ...bound, status: 'needs_review', code: 'UNEXPECTED_VARIANT_SKU', variantIds: unexpected.map(row => row.id as string) };
    }
    const blank = variants.filter(variant => variant.sku === null);
    if (blank.length) {
      return { ...bound, status: 'pending_skus', variantIds: blank.map(row => row.id as string) };
    }
    return { ...bound, status: 'ready' };
  }

  sheetsCompletionAdapter(): SheetsCompletionAdapter {
    return {
      inspect: async target => this.inspectGarment(target),
      markComplete: async (target, productId) => this.transaction(() => {
        const report = this.inspectGarment(target, productId);
        if (report.status !== 'ready') return report;
        this.db.prepare(`
          UPDATE master_input_fixtures SET cells = json_set(cells, '$[8]', 'Yes')
          WHERE row_number = ? AND json_extract(cells, '$[7]') = ? AND json_extract(cells, '$[10]') = ?
            AND (json_type(cells, '$[8]') = 'null' OR json_extract(cells, '$[8]') = '')
        `).run(target.sourceRow, target.productSku, target.artworkSku);
        return { ...report, status: 'completed' };
      }),
    };
  }

  getExport(id: string): ExportJob {
    const row = this.db.prepare('SELECT body FROM mockupify_exports WHERE id = ?').get(id);
    if (!row) throw new WorkerError('EXPORT_NOT_FOUND', 'No Mockupify export matches that ID.');
    return JSON.parse(row.body as string) as ExportJob;
  }

  private saveExport(job: ExportJob): ExportJob {
    this.db.prepare('UPDATE mockupify_exports SET body = ?, export_ref = ? WHERE id = ?')
      .run(JSON.stringify(job), job.evidence?.exportRef ?? null, job.id);
    return job;
  }

  queueExport(plan: ExportPlan, mode: Mode, now: number): ExportJob {
    return this.transaction(() => {
      const identity = JSON.stringify([mode, plan.artworkSku]);
      const row = this.db.prepare('SELECT body FROM mockupify_exports WHERE identity = ?').get(identity);
      const previous = row ? JSON.parse(row.body as string) as ExportJob : undefined;
      if (previous && JSON.stringify(previous.plan) === JSON.stringify(plan)) return previous;
      if (previous && mode === 'simulate' && !previous.plan.issues.length) {
        throw new WorkerError('EXPORT_PLAN_CONFLICT', 'This artwork already has a different export plan.');
      }
      const status = plan.issues.length ? 'needs_review' : mode === 'dry-run' ? 'planned' : 'queued';
      const job: ExportJob = { id: previous?.id ?? randomUUID(), mode, plan, status, availableAt: now };
      if (previous) {
        this.saveExport(job);
      } else {
        this.db.prepare('INSERT INTO mockupify_exports (id, identity, body) VALUES (?, ?, ?)')
          .run(job.id, identity, JSON.stringify(job));
      }
      if (status === 'queued') {
        for (const garment of plan.products) {
          const reserved = this.db.prepare('SELECT export_id FROM mockupify_export_reservations WHERE product_sku = ?')
            .get(garment.productSku);
          if (reserved || this.findShopifyBindings(garment.productSku).length) {
            throw new WorkerError('EXPORT_PRODUCT_CONFLICT', 'A Product SKU is already bound or reserved for export.');
          }
          this.db.prepare('INSERT INTO mockupify_export_reservations (product_sku, export_id) VALUES (?, ?)')
            .run(garment.productSku, job.id);
        }
      }
      return job;
    });
  }

  beginExport(id: string, clock: () => number, marginMinutes: number | undefined): boolean {
    return this.transaction(() => {
      const job = this.getExport(id);
      if (job.mode !== 'simulate' || !['queued', 'deferred'].includes(job.status) || job.availableAt > clock()) return false;
      if (job.plan.products.some(row => this.findShopifyBindings(row.productSku).length)) {
        this.saveExport({ ...job, status: 'needs_review', code: 'EXPORT_PRODUCT_CONFLICT' });
        return false;
      }
      try {
        assertExportWindow(clock(), marginMinutes);
      } catch (error) {
        if (!(error instanceof ProductionWriteDeferred)) throw error;
        this.saveExport({ ...job, status: 'deferred', availableAt: error.retryAt, code: error.code });
        return false;
      }
      // Commit an irreversible dispatch claim before allowing the adapter to perform work.
      this.saveExport({ id, mode: job.mode, plan: job.plan, status: 'dispatching', availableAt: clock() });
      return true;
    });
  }

  deferExportBeforeDispatch(id: string, error: ProductionWriteDeferred): ExportJob {
    return this.transaction(() => {
      const job = this.getExport(id);
      if (job.status !== 'dispatching') return job;
      return this.saveExport({ ...job, status: 'deferred', availableAt: error.retryAt, code: error.code });
    });
  }

  markExportUncertain(id: string, code: string): ExportJob {
    return this.transaction(() => {
      const job = this.getExport(id);
      if (job.status !== 'dispatching' && job.status !== 'uncertain') return job;
      return this.saveExport({ ...job, status: 'uncertain', code });
    });
  }

  recordExportEvidence(id: string, input: unknown): ExportJob {
    return this.transaction(() => {
      const job = this.getExport(id);
      if (job.mode !== 'simulate' || !['dispatching', 'uncertain', 'completed'].includes(job.status)) {
        throw new WorkerError('EXPORT_NOT_RECONCILABLE', 'Only a dispatched export can accept reconciliation evidence.');
      }
      const { correlationId, exportRef, bindings } = parseExportEvidence(input, job);
      const owner = this.db.prepare('SELECT id FROM mockupify_exports WHERE export_ref = ?').get(exportRef);
      if ((job.evidence && job.evidence.exportRef !== exportRef) || (owner && owner.id !== id)) {
        throw new WorkerError('EXPORT_BINDING_CONFLICT', 'The Mockupify export reference does not match this dispatch.');
      }
      const merged = new Map(job.evidence?.bindings.map(binding => [binding.sourceRow, binding]));
      for (const binding of bindings) {
        const existing = merged.get(binding.sourceRow);
        if ((existing && JSON.stringify(existing) !== JSON.stringify(binding))
          || this.findShopifyBindings(binding.product.productSku).some(product => product.id !== binding.product.id)) {
          throw new WorkerError('EXPORT_BINDING_CONFLICT', 'An exported garment already has a conflicting Shopify binding.');
        }
        merged.set(binding.sourceRow, binding);
      }
      this.insertShopifyFixtures(bindings.map(binding => binding.product));
      const evidence = { correlationId, exportRef, bindings: [...merged.values()].sort((a, b) => a.sourceRow - b.sourceRow) };
      const { code: _, ...state } = job;
      return this.saveExport(merged.size === job.plan.products.length
        ? { ...state, status: 'completed', evidence }
        : { ...state, status: 'uncertain', code: 'PARTIAL_EXPORT_EVIDENCE', evidence });
    });
  }

  importShopifyFixtures(input: unknown): number {
    const products = parseShopifyCatalog(input);
    return this.transaction(() => this.insertShopifyFixtures(products));
  }

  private insertShopifyFixtures(products: ShopifyProduct[]): number {
    let imported = 0;
    for (const product of products) {
      const baseline = JSON.stringify(product);
      const row = this.db.prepare('SELECT fixture FROM shopify_products WHERE id = ?').get(product.id);
      if (row) {
        if (row.fixture !== baseline) {
          throw new WorkerError('FIXTURE_CONFLICT', 'An existing Shopify product fixture differs from this import.');
        }
        continue;
      }
      this.db.prepare('INSERT INTO shopify_products (id, artwork_sku, product_sku, fixture) VALUES (?, ?, ?, ?)')
        .run(product.id, product.artworkSku, product.productSku, baseline);
      for (const variant of product.variants) {
        if (this.db.prepare('SELECT id FROM shopify_variants WHERE id = ?').get(variant.id)) {
          throw new WorkerError('FIXTURE_CONFLICT', 'A Shopify variant ID is already registered to a product.');
        }
        this.db.prepare('INSERT INTO shopify_variants (id, product_id, size, color, sku) VALUES (?, ?, ?, ?, ?)')
          .run(variant.id, product.id, variant.size, variant.color, variant.sku);
      }
      imported += 1;
    }
    return imported;
  }

  private findShopifyBindings(productSku: string): ShopifyProductBinding[] {
    return this.db.prepare(`
      SELECT id, artwork_sku, json_extract(fixture, '$.mockupifyExportRef') AS export_ref,
        json_extract(fixture, '$.sourceRow') AS source_row
      FROM shopify_products WHERE product_sku = ? ORDER BY id
    `).all(productSku).map(row => ({
      id: row.id as string, artworkSku: row.artwork_sku as string, productSku,
      ...(typeof row.export_ref === 'string' ? { mockupifyExportRef: row.export_ref } : {}),
      ...(typeof row.source_row === 'number' ? { sourceRow: row.source_row } : {}),
    }));
  }

  private findShopifyProducts(productSku: string): ShopifyProduct[] {
    const variants = this.db.prepare('SELECT id, size, color, sku FROM shopify_variants WHERE product_id = ? ORDER BY id');
    return this.findShopifyBindings(productSku).map(binding => ({
      ...binding,
      variants: variants.all(binding.id).map(row => ({
        id: row.id as string, size: row.size as string, color: row.color as string, sku: row.sku as string | null,
      })),
    }));
  }

  private assignShopifySku(target: InitialSkuTarget, clock: () => number) {
    return this.transaction(() => {
      const product = resolveProduct(this.findShopifyBindings(target.productSku), target.artworkSku);
      const variant = this.db.prepare('SELECT sku FROM shopify_variants WHERE product_id = ? AND id = ?')
        .get(product.id, target.variantId);
      if (product.id !== target.productId || !variant) {
        throw new WorkerError('PRODUCT_BINDING_CONFLICT', 'The Shopify product or variant binding changed before assignment.');
      }
      const outcome = existingSku(variant.sku as string | null, target.productSku);
      if (outcome) return outcome;
      const update = this.db.prepare('UPDATE shopify_variants SET sku = ? WHERE product_id = ? AND id = ? AND sku IS NULL');
      assertSkuWindow(clock());
      update.run(target.productSku, target.productId, target.variantId);
      return { outcome: 'assigned' as const };
    });
  }

  shopifySkuAdapter(): ShopifySkuAdapter {
    return {
      findProducts: async productSku => this.findShopifyProducts(productSku),
      assignInitialSku: async (target, clock) => this.assignShopifySku(target, clock),
    };
  }

  applyEffect(
    key: string, action: WriteAction, request: Details, apply: () => Details, beforeWrite?: () => void,
  ): Effect {
    return this.transaction(() => {
      const payload = JSON.stringify(request);
      const row = this.db.prepare('SELECT action, request, details FROM effects WHERE key = ?').get(key);
      if (row) {
        if (row.action !== action || row.request !== payload) {
          throw new WorkerError('EFFECT_CONFLICT', 'An existing simulated write has a different request for this identity.');
        }
        return { details: JSON.parse(row.details as string) as Details, reused: true };
      }
      const details = apply();
      const insert = this.db.prepare('INSERT INTO effects (key, action, request, details) VALUES (?, ?, ?, ?)');
      const serialized = JSON.stringify(details);
      beforeWrite?.();
      insert.run(key, action, payload, serialized);
      return { details, reused: false };
    });
  }

  effectCounts(): Record<string, number> {
    return Object.fromEntries(this.db.prepare('SELECT action, COUNT(*) AS count FROM effects GROUP BY action').all()
      .map(row => [row.action as string, row.count as number]));
  }
}
