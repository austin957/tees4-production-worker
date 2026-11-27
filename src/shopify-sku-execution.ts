import { requiredText } from './config.js';
import { mockupifyDigest } from './mockupify-writer-model.js';
import { skuEvidenceDigest, validateMockupifySkuReplacement } from './mockupify-sku-replacement.js';
import type { SkuReplacementEvidence } from './mockupify-sku-replacement.js';
import { WorkerError } from './model.js';
import { assertSkuWindow, protectedUntil } from './production-schedule.js';
import { adjustTag, readStableShopifyProduct } from './shopify-readonly.js';
import type { ProductRead } from './shopify-readonly.js';
import type { Dispatch } from './shopify-sku-journal.js';
import { skuBulkUpdateRequest, skuWriteScope } from './shopify-sku-write-adapter.js';
import type { SimulatedSkuWriter, SkuBulkResponse } from './shopify-sku-write-adapter.js';
import type { Store } from './store.js';

type PlanStore = Pick<Store, 'getProductBinding' | 'inspectMockupifyJournal'>;
type ExecutionStore = PlanStore & Pick<Store, 'shopifySkuJournal'>;
type Variant = { variantId: string; color: string; size: string; currentSku: string; targetSku: string };
export type SkuReplacementPlan = {
  id: string;
  version: 1;
  bindingId: string;
  shopId: string;
  productId: string;
  rowNumber: number;
  productSku: string;
  artworkSku: string;
  provenance: { correlationId: string; batchId: number; designId: number; exportId: number };
  evidenceDigest: string;
  sourceDigest: string;
  productShapeDigest: string;
  requestDigest: string;
  variants: readonly Variant[];
};

const approvalLifetime = 15 * 60_000;
const digest = (value: unknown) => mockupifyDigest(JSON.stringify(value));

function productShapeDigest({ updatedAt: _updatedAt, variants, ...product }: ProductRead) {
  // SKU changes can advance updatedAt. All other data in the complete Phase 22A snapshot must match.
  return digest({ ...product, variants: variants.map(({ sku: _sku, ...variant }) => variant) });
}

async function buildPlan(store: PlanStore, bindingId: string, evidence: SkuReplacementEvidence, shopifyLast = false) {
  const { binding, provenance, variants, evidenceDigest, source } =
    await validateMockupifySkuReplacement(store, bindingId, evidence, shopifyLast);
  const { shopId, productId, rowNumber, productSku, artworkSku } = binding;
  const request = skuBulkUpdateRequest(productId, variants);
  const body = {
    version: 1 as const, bindingId, shopId, productId, rowNumber, productSku, artworkSku, provenance, evidenceDigest,
    sourceDigest: digest(source), productShapeDigest: productShapeDigest(binding.shopifySnapshot),
    requestDigest: digest(request), variants,
  };
  return { plan: { id: digest(body), ...body }, request };
}

export async function dryRunSkuReplacement(store: PlanStore, bindingId: string, evidence: SkuReplacementEvidence, clock = Date.now) {
  const { plan, request } = await buildPlan(store, bindingId, evidence);
  const until = protectedUntil(clock());
  return {
    mode: 'dry_run', liveWritesEnabled: false, executionAuthorized: false,
    status: until === undefined ? 'ELIGIBLE_FOR_REVIEW' : 'DEFERRED_PROTECTED_WINDOW',
    futureWritesProtectedUntil: until === undefined ? null : new Date(until).toISOString(),
    variantCount: plan.variants.length, plan, request,
  };
}

function assertEvidenceCurrent(store: PlanStore, plan: SkuReplacementPlan) {
  if (skuEvidenceDigest(store.getProductBinding(plan.bindingId),
    store.inspectMockupifyJournal(plan.provenance.correlationId)) !== plan.evidenceDigest) {
    throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'The binding or Mockupify evidence changed after review.');
  }
}

export async function approveSkuReplacement(
  store: ExecutionStore, bindingId: string, planId: string, by: string, source: string, evidence: SkuReplacementEvidence, clock = Date.now,
) {
  const { plan } = await buildPlan(store, bindingId, evidence);
  if (plan.id !== planId) throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'The reviewed plan ID does not match current evidence.');
  const approvedAt = clock();
  return store.shopifySkuJournal.approve(plan, {
    by: requiredText(by, 'Approver'), source: requiredText(source, 'Execution approval evidence'),
    approvedAt, expiresAt: approvedAt + approvalLifetime,
  }, () => assertEvidenceCurrent(store, plan));
}

function errorCode(error: unknown, fallback: string) {
  return error instanceof WorkerError ? error.code : fallback;
}

function assertHextomPaused(writer: SimulatedSkuWriter, productId: string) {
  if (writer.hextomPaused(productId) !== true) {
    throw new WorkerError('SKU_EXECUTION_HEXTOM_HOLD', 'A confirmed Hextom pause is required before dispatch.');
  }
}

export async function simulateSkuReplacement(
  store: ExecutionStore, planId: string, approvalSequence: number, evidence: SkuReplacementEvidence,
  writer: SimulatedSkuWriter, clock = Date.now,
) {
  const journal = store.shopifySkuJournal;
  const plan = journal.getPlan(planId);
  let request: ReturnType<typeof skuBulkUpdateRequest>;
  let dispatch: Dispatch | undefined;
  try {
    journal.assertNoDispatch(plan);
    journal.assertApproval(planId, approvalSequence, clock());
    assertSkuWindow(clock());
    const shop = await writer.verifyShop();
    if (shop.id !== plan.shopId) throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The writer is authenticated to a different shop.');
    if (!shop.scopes.includes(skuWriteScope)) {
      throw new WorkerError('SKU_EXECUTION_WRITE_SCOPE_REQUIRED', 'The Shopify installation requires write_products for this mutation.');
    }
    const fresh = await buildPlan(store, plan.bindingId, evidence, true);
    const { id, ...body } = plan;
    if (fresh.plan.id !== id || id !== planId || digest(body) !== id) {
      throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'The complete rechecked plan differs from the approved plan.');
    }
    request = fresh.request;
    assertHextomPaused(writer, plan.productId);
    assertSkuWindow(clock());
    dispatch = journal.claim(plan, approvalSequence, clock(), () => assertEvidenceCurrent(store, plan));
    assertHextomPaused(writer, plan.productId);
    const beforeSend = clock();
    journal.assertApproval(planId, approvalSequence, beforeSend);
    assertSkuWindow(beforeSend);
  } catch (error) {
    const code = errorCode(error, 'SKU_EXECUTION_PREFLIGHT_FAILED');
    if (dispatch) journal.cancelBeforeSend(dispatch, clock(), code);
    else journal.append(planId, { event: 'blocked', at: clock(), code });
    throw error;
  }

  let response: SkuBulkResponse | undefined;
  try {
    response = await writer.updateSkus(request);
  } catch (error) {
    journal.append(planId, { event: 'dispatch_error', dispatchId: dispatch.id, at: clock(),
      code: errorCode(error, 'SKU_EXECUTION_NETWORK_UNCERTAIN') });
  }
  if (response) journal.append(planId, { event: 'shopify_response', dispatchId: dispatch.id, at: clock(), response });
  return reconcileSkuReplacement(store, planId, evidence, clock);
}

export async function reconcileSkuReplacement(
  store: ExecutionStore, planId: string, evidence: Pick<SkuReplacementEvidence, 'shopId' | 'shopify'>, clock = Date.now,
) {
  const journal = store.shopifySkuJournal;
  const plan = journal.getPlan(planId);
  const dispatch = journal.dispatchFor(planId);
  try {
    if (evidence.shopId !== plan.shopId) throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The reader is configured for a different shop.');
    const product = await readStableShopifyProduct(evidence.shopify, plan.productId);
    if (!product || product.id !== plan.productId) {
      throw new WorkerError('SHOPIFY_PRODUCT_CHANGED', 'Readback requires a stable snapshot of the exact Shopify product.');
    }
    const byId = new Map<string, ProductRead['variants']>();
    for (const variant of product.variants) {
      if (variant.id !== null) {
        const seen = byId.get(variant.id) ?? [];
        seen.push(variant);
        byId.set(variant.id, seen);
      }
    }
    const variants = plan.variants.map(({ variantId, currentSku, targetSku }) => {
      const matches = byId.get(variantId) ?? [];
      const observedSku = matches.length === 1 ? matches[0]!.sku : null;
      const status = matches.length === 0 ? 'MISSING' : matches.length > 1 ? 'DUPLICATE'
        : observedSku === targetSku ? 'AT_TARGET' : observedSku === currentSku ? 'AT_ORIGINAL' : 'UNEXPECTED';
      return { variantId, observedSku, status } as const;
    });
    const recorded = journal.inspect(planId).events.findLast(event => event.event === 'shopify_response' && event.dispatchId === dispatch.id);
    const response = recorded?.event === 'shopify_response' ? recorded.response : undefined;
    const responseAccepted = response !== undefined && !response.graphqlErrorCodes?.length &&
      (response.httpStatus === undefined || response.httpStatus >= 200 && response.httpStatus < 300);
    let status: string;
    if (!product.tags.includes(adjustTag) || variants.some(variant => variant.status === 'UNEXPECTED')) {
      status = 'HELD_POSSIBLE_HEXTOM_OR_UNEXPECTED_SKU';
    } else if (productShapeDigest(product) !== plan.productShapeDigest) {
      status = 'HELD_PRODUCT_CHANGED';
    } else if (variants.every(variant => variant.status === 'AT_TARGET')) {
      const returned = response?.variants ?? [];
      const returnedSkus = new Map(returned.map(variant => [variant.id, variant.sku]));
      const confirmed = responseAccepted && response.userErrors?.length === 0 &&
        response.productId === plan.productId && returned.length === plan.variants.length &&
        plan.variants.every(variant => returnedSkus.get(variant.variantId) === variant.targetSku);
      status = confirmed ? 'VERIFIED_COMPLETE' : 'VERIFIED_TARGETS_DISPATCH_UNCONFIRMED';
    } else if (variants.some(variant => variant.status === 'AT_TARGET')) {
      status = 'HELD_PARTIAL_UPDATE';
    } else {
      status = responseAccepted && response.userErrors?.length &&
        !response.variants?.length ? 'VERIFIED_REJECTED' : 'HELD_DISPATCH_UNCONFIRMED';
    }
    journal.append(planId, { event: 'readback', at: clock(), dispatchId: dispatch.id, status, variants });
    return { planId, dispatchId: dispatch.id, status, variants };
  } catch (error) {
    journal.append(planId, { event: 'readback_error', at: clock(), dispatchId: dispatch.id,
      code: errorCode(error, 'SKU_EXECUTION_READBACK_FAILED') });
    throw error;
  }
}
