import { requiredText } from './config.js';
import { mockupifyDigest } from './mockupify-writer-model.js';
import { skuEvidenceDigest, validateMockupifySkuReplacement } from './mockupify-sku-replacement.js';
import type { parseExportDetail } from './mockupify-readonly.js';
import type { SkuReplacementEvidence } from './mockupify-sku-replacement.js';
import { WorkerError } from './model.js';
import { assertSkuWindow, protectedUntil } from './production-schedule.js';
import { adjustTag, readStableShopifyProduct } from './shopify-readonly.js';
import type { ProductRead } from './shopify-readonly.js';
import { verifyHextomPause } from './shopify-sku-hextom.js';
import type { HextomPauseReader } from './shopify-sku-hextom.js';
import type { Dispatch, LiveDispatchEvidence } from './shopify-sku-journal.js';
import { mutationTimeoutMs, skuBulkUpdateRequest, skuWriteScope } from './shopify-sku-write-adapter.js';
import type { SimulatedSkuWriter, SkuBulkResponse, SkuWriter } from './shopify-sku-write-adapter.js';
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

type LiveEvidence = {
  readExport: (id: number) => Promise<ReturnType<typeof parseExportDetail>>;
  readPause: HextomPauseReader;
};

async function buildPlan(
  store: PlanStore, bindingId: string, evidence: SkuReplacementEvidence, shopifyLast = false, readExport?: LiveEvidence['readExport'],
) {
  const { binding, provenance, variants, evidenceDigest, source } =
    await validateMockupifySkuReplacement(store, bindingId, evidence, shopifyLast, readExport);
  const { shopId, productId, rowNumber, productSku, artworkSku } = binding;
  const request = skuBulkUpdateRequest(productId, variants);
  const body = {
    version: 1 as const, bindingId, shopId, productId, rowNumber, productSku, artworkSku, provenance, evidenceDigest,
    sourceDigest: digest(source), productShapeDigest: productShapeDigest(binding.shopifySnapshot),
    requestDigest: digest(request), variants,
  };
  return { plan: { id: digest(body), ...body }, request };
}

export async function dryRunSkuReplacement(
  store: PlanStore, bindingId: string, evidence: SkuReplacementEvidence, clock = Date.now, readExport?: LiveEvidence['readExport'],
) {
  const { plan, request } = await buildPlan(store, bindingId, evidence, false, readExport);
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
  store: ExecutionStore, bindingId: string, planId: string, by: string, source: string, evidence: SkuReplacementEvidence, clock = Date.now, forLive = false,
) {
  const { plan } = await buildPlan(store, bindingId, evidence);
  if (plan.id !== planId) throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'The reviewed plan ID does not match current evidence.');
  const approvedAt = clock();
  return store.shopifySkuJournal.approve(plan, {
    by: requiredText(by, 'Approver'), source: requiredText(source, 'Execution approval evidence'),
    approvedAt, expiresAt: approvedAt + approvalLifetime, ...(forLive ? { forLive: true } : {}),
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

export function simulateSkuReplacement(
  store: ExecutionStore, planId: string, approvalSequence: number, evidence: SkuReplacementEvidence,
  writer: SimulatedSkuWriter, clock = Date.now,
) {
  return dispatchSkuReplacement(store, planId, approvalSequence, evidence, writer, clock,
    productId => assertHextomPaused(writer, productId));
}

export async function executeSkuReplacement(
  store: ExecutionStore, options: { execute: boolean; bindingId: string; planId: string; approvalSequence: number },
  evidence: SkuReplacementEvidence & LiveEvidence, writer: SkuWriter, clock = Date.now,
) {
  if (options.execute !== true || typeof options.planId !== 'string' || !/^[a-f0-9]{64}$/.test(options.planId) ||
    !Number.isSafeInteger(options.approvalSequence) || options.approvalSequence < 1) {
    throw new WorkerError('SKU_EXECUTION_APPROVAL_REQUIRED', 'Explicit execution, the exact plan ID and its approval sequence are required.');
  }
  if (typeof evidence.readExport !== 'function') {
    throw new WorkerError('MOCKUPIFY_PROVENANCE_REQUIRED', 'Live Mockupify export verification is required.');
  }
  const plan = store.shopifySkuJournal.getPlan(options.planId);
  if (plan.bindingId !== options.bindingId || plan.variants.length !== 14) {
    throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'Live execution requires the exact binding and all 14 approved variants.');
  }
  return dispatchSkuReplacement(store, options.planId, options.approvalSequence, evidence, writer, clock, undefined, evidence);
}

async function dispatchSkuReplacement(
  store: ExecutionStore, planId: string, approvalSequence: number, evidence: SkuReplacementEvidence,
  writer: SkuWriter, clock: () => number, checkSimulatedPause?: (productId: string) => void, live?: LiveEvidence,
) {
  const journal = store.shopifySkuJournal;
  const plan = journal.getPlan(planId);
  let request: ReturnType<typeof skuBulkUpdateRequest>;
  let dispatch: Dispatch | undefined;
  let liveDispatch: LiveDispatchEvidence | undefined;
  try {
    journal.assertNoDispatch(plan);
    journal.assertApproval(planId, approvalSequence, clock(), live !== undefined);
    assertSkuWindow(clock());
    const shop = await writer.verifyShop();
    if (shop.id !== plan.shopId) throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The writer is authenticated to a different shop.');
    if (!shop.scopes.includes(skuWriteScope)) {
      throw new WorkerError('SKU_EXECUTION_WRITE_SCOPE_REQUIRED', 'The Shopify installation requires write_products for this mutation.');
    }
    if (live) {
      if (!shop.installationId) {
        throw new WorkerError('SKU_EXECUTION_INSTALLATION_UNAUTHORIZED', 'The acting Shopify installation must be verified.');
      }
      liveDispatch = { installationId: shop.installationId, hextomPause: verifyHextomPause(live.readPause, plan, clock, mutationTimeoutMs) };
    }
    const fresh = await buildPlan(store, plan.bindingId, evidence, true, live?.readExport);
    const { id, ...body } = plan;
    if (fresh.plan.id !== id || id !== planId || digest(body) !== id) {
      throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'The complete rechecked plan differs from the approved plan.');
    }
    request = fresh.request;
    checkSimulatedPause?.(plan.productId);
    assertSkuWindow(clock());
    dispatch = journal.claim(plan, approvalSequence, clock(), () => assertEvidenceCurrent(store, plan), liveDispatch);
    checkSimulatedPause?.(plan.productId);
    if (live && verifyHextomPause(live.readPause, plan, clock, mutationTimeoutMs).digest !== liveDispatch?.hextomPause.digest) {
      throw new WorkerError('SKU_EXECUTION_HEXTOM_HOLD', 'Hextom pause evidence changed during verification.');
    }
    const beforeSend = clock();
    journal.assertApproval(planId, approvalSequence, beforeSend, live !== undefined);
    const dispatchTime = clock();
    if (liveDispatch && liveDispatch.hextomPause.holdUntil <= dispatchTime + mutationTimeoutMs) {
      throw new WorkerError('SKU_EXECUTION_HEXTOM_HOLD', 'The verified Hextom pause expires too soon to dispatch.');
    }
    assertSkuWindow(dispatchTime);
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
  if (live && !acknowledged(plan, response)) {
    throw new WorkerError('SKU_EXECUTION_RECONCILIATION_REQUIRED', 'The Shopify result was not fully acknowledged. Run read-only reconciliation for this plan.');
  }
  try {
    return await readbackSkuReplacement(store, planId, evidence, clock, live?.readPause);
  } catch (error) {
    if (!live) throw error;
    throw new WorkerError('SKU_EXECUTION_RECONCILIATION_REQUIRED', 'Shopify acknowledged the request, but readback failed. Run read-only reconciliation for this plan.');
  }
}

function responseAccepted(response: SkuBulkResponse | undefined): response is SkuBulkResponse {
  return response !== undefined && !response.graphqlErrorCodes?.length &&
    (response.httpStatus === undefined || response.httpStatus >= 200 && response.httpStatus < 300);
}

function acknowledged(plan: SkuReplacementPlan, response: SkuBulkResponse | undefined) {
  if (!responseAccepted(response) || response.userErrors?.length !== 0 || response.productId !== plan.productId ||
    response.variants?.length !== plan.variants.length) return false;
  const returnedSkus = new Map(response.variants.map(variant => [variant.id, variant.sku]));
  return returnedSkus.size === plan.variants.length && plan.variants.every(variant => returnedSkus.get(variant.variantId) === variant.targetSku);
}

type ReadbackEvidence = Pick<SkuReplacementEvidence, 'shopId' | 'shopify'>;

export function reconcileSkuReplacement(store: ExecutionStore, planId: string, evidence: ReadbackEvidence, clock = Date.now) {
  return readbackSkuReplacement(store, planId, evidence, clock);
}

async function readbackSkuReplacement(
  store: ExecutionStore, planId: string, evidence: ReadbackEvidence, clock: () => number, readPause?: HextomPauseReader,
) {
  const journal = store.shopifySkuJournal;
  const plan = journal.getPlan(planId);
  const dispatch = journal.dispatchFor(planId);
  const events = journal.inspect(planId).events;
  const claim = events.find(event => event.event === 'claimed' && event.dispatchId === dispatch.id);
  const live = claim?.event === 'claimed' ? claim.live : undefined;
  function pauseConfirmed() {
    if (!live || !readPause) return false;
    try {
      return verifyHextomPause(readPause, plan, clock).digest === live.hextomPause.digest;
    } catch {
      return false;
    }
  }
  try {
    if (evidence.shopId !== plan.shopId) throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The reader is configured for a different shop.');
    const pausedBefore = pauseConfirmed();
    const product = await readStableShopifyProduct(evidence.shopify, plan.productId);
    if (!product || product.id !== plan.productId) {
      throw new WorkerError('SHOPIFY_PRODUCT_CHANGED', 'Readback requires a stable snapshot of the exact Shopify product.');
    }
    const hextomPauseVerified = readPause ? pausedBefore && pauseConfirmed() :
      events.some(event => event.event === 'readback' && event.dispatchId === dispatch.id && event.hextomPauseVerified === true);
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
    const recorded = events.findLast(event => event.event === 'shopify_response' && event.dispatchId === dispatch.id);
    const response = recorded?.event === 'shopify_response' ? recorded.response : undefined;
    let status: string;
    if (!product.tags.includes(adjustTag) || variants.some(variant => variant.status === 'UNEXPECTED')) {
      status = 'HELD_POSSIBLE_HEXTOM_OR_UNEXPECTED_SKU';
    } else if (productShapeDigest(product) !== plan.productShapeDigest) {
      status = 'HELD_PRODUCT_CHANGED';
    } else if (variants.every(variant => variant.status === 'AT_TARGET')) {
      status = !acknowledged(plan, response) ? 'VERIFIED_TARGETS_DISPATCH_UNCONFIRMED'
        : live && !hextomPauseVerified ? 'HELD_HEXTOM_PAUSE_UNVERIFIED' : 'VERIFIED_COMPLETE';
    } else if (variants.some(variant => variant.status === 'AT_TARGET')) {
      status = 'HELD_PARTIAL_UPDATE';
    } else {
      status = responseAccepted(response) && response.userErrors?.length &&
        !response.variants?.length ? 'VERIFIED_REJECTED' : 'HELD_DISPATCH_UNCONFIRMED';
    }
    journal.append(planId, { event: 'readback', at: clock(), dispatchId: dispatch.id, status, variants,
      ...(live ? { hextomPauseVerified } : {}) });
    return { planId, dispatchId: dispatch.id, status, variants };
  } catch (error) {
    journal.append(planId, { event: 'readback_error', at: clock(), dispatchId: dispatch.id,
      code: errorCode(error, 'SKU_EXECUTION_READBACK_FAILED') });
    throw error;
  }
}
