import { createHash } from 'node:crypto';
import { WorkerError } from './model.js';
import { verifyHextom } from './shopify-hextom.js';
import { assessProductionStage } from './shopify-production-audit.js';
import { readStableShopifyProduct } from './shopify-readonly.js';
import type { ShopifyReadonlyClient } from './shopify-readonly.js';
import type { Store } from './store.js';

type HextomComparison = ReturnType<typeof verifyHextom>;
type ReportStatus = 'PRE_HEXTOM_PREPARATION' | 'HEXTOM_PROCESSING_OR_PENDING' | 'HEXTOM_EXCEPTIONS_WITH_ADJUST'
  | 'PROCESSING_UNCONFIRMED' | 'POST_HEXTOM_EXCEPTIONS' | 'VERIFIED_COMPLETE' | 'CANDIDATE_SKUS_MATCH';

function variantIssues(comparison: HextomComparison, variant: HextomComparison['variants'][number], base: string) {
  const { id, currentSku, expectedSku, option1, option2, status } = variant;
  const issues: string[] = [];
  if (status === 'INITIAL') {
    if (!comparison.hasAdjustTag || comparison.counts.TRANSFORMED > 0 || comparison.counts.DUPLICATE_TRANSFORMATION > 0) {
      issues.push('INITIAL_SKU_REMAINS');
    }
  } else if (status !== 'TRANSFORMED') {
    issues.push(status);
  }
  if (id === null) issues.push('MISSING_VARIANT_ID');
  else if (comparison.duplicateVariantIds.includes(id)) issues.push('DUPLICATE_VARIANT_ID');
  if (currentSku !== null && comparison.duplicateNonBaseSkus.includes(currentSku)) issues.push('DUPLICATE_CURRENT_SKU');
  if (expectedSku === null && status !== 'INVALID_OPTIONS') issues.push('INVALID_OPTIONS');
  if (expectedSku !== null && comparison.duplicateExpectedSkus.includes(expectedSku)) issues.push('DUPLICATE_EXPECTED_SKU');

  if (status === 'UNEXPECTED_SKU' && currentSku !== null && option1 !== null && option2 !== null) {
    const suffix = `-${option1}-${option2}`;
    if (currentSku.length > suffix.length && currentSku.endsWith(suffix)) {
      const prefix = currentSku.slice(0, -suffix.length);
      issues.push('CONFLICTING_BASE_SKU');
      if (prefix.length > suffix.length && prefix.endsWith(suffix)) issues.push('REPEATED_OPTION_SUFFIX');
    } else if (currentSku.startsWith(`${base}-`)) {
      issues.push('INCORRECT_OPTION_SUFFIX');
    }
  }
  return issues.sort();
}

function reportStatus(comparison: HextomComparison, verified: boolean): ReportStatus {
  const transformationObserved = comparison.counts.TRANSFORMED > 0 || comparison.counts.DUPLICATE_TRANSFORMATION > 0;
  if (!comparison.hasAdjustTag) {
    if (!transformationObserved) return 'PROCESSING_UNCONFIRMED';
    if (comparison.issues.length) return 'POST_HEXTOM_EXCEPTIONS';
    return verified ? 'VERIFIED_COMPLETE' : 'CANDIDATE_SKUS_MATCH';
  }
  if (!transformationObserved) return 'PRE_HEXTOM_PREPARATION';
  return comparison.issues.every(issue => issue === 'PARTIALLY_TRANSFORMED')
    ? 'HEXTOM_PROCESSING_OR_PENDING' : 'HEXTOM_EXCEPTIONS_WITH_ADJUST';
}

function alertId(bindingId: string, data: unknown): string {
  return createHash('sha256').update(JSON.stringify([bindingId, data])).digest('hex');
}

export async function reportPostHextom(
  store: Pick<Store, 'getProductBinding' | 'recordPostHextomAlerts'>,
  client: Pick<ShopifyReadonlyClient, 'product'>, shopId: string, bindingId: string, clock = Date.now,
) {
  const binding = store.getProductBinding(bindingId);
  if (binding.shopId !== shopId) throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The binding is for a different Shopify shop.');
  if (binding.status !== 'approved' && binding.status !== 'proposed') {
    throw new WorkerError('BINDING_REPORT_UNAVAILABLE', 'Only approved or proposed bindings can be audited.');
  }
  if (binding.status === 'approved' && !binding.confirmation) {
    throw new WorkerError('BINDING_REPORT_UNAVAILABLE', 'The approved binding has no recorded confirmation.');
  }
  const verified = binding.status === 'approved';
  const source = {
    bindingId, bindingStatus: binding.status, spreadsheetId: binding.spreadsheetId, rowNumber: binding.rowNumber,
    verification: verified ? 'REGISTRY_APPROVED' : 'UNVERIFIED_CANDIDATE',
    verifiedBaseSku: verified ? binding.productSku : null, candidateBaseSku: verified ? null : binding.productSku,
  };
  const current = await readStableShopifyProduct(client, binding.productId);
  const context = { source, shopId, productId: binding.productId };
  if (!current) {
    return { ...context, status: 'NEEDS_RECONCILIATION', issues: ['SHOPIFY_SNAPSHOT_CHANGED'], exceptions: [], alerts: [] };
  }
  if (current.id !== binding.productId) {
    throw new WorkerError('SHOPIFY_PRODUCT_MISMATCH', 'The product returned by Shopify differs from the binding.');
  }

  // A proposed binding supplies a comparison string only. It never supplies verified source evidence.
  const comparison = verifyHextom(current, binding.productSku);
  const productionAudit = assessProductionStage(comparison, verified);
  const status = reportStatus(comparison, verified);
  const actionable = status === 'POST_HEXTOM_EXCEPTIONS' || status === 'HEXTOM_EXCEPTIONS_WITH_ADJUST' || status === 'PROCESSING_UNCONFIRMED';
  const exceptions = comparison.variants.flatMap(variant => {
    const issues = variantIssues(comparison, variant, binding.productSku);
    if (!issues.length) return [];
    return [{
      variantId: variant.id, options: variant.selectedOptions, currentSku: variant.currentSku, issues,
      expectedSku: verified ? variant.expectedSku : null, expectedSkuCandidate: verified ? null : variant.expectedSku,
      alertId: actionable ? alertId(bindingId, [variant.id, variant.currentSku, variant.expectedSku, issues,
        variant.id === null ? variant.selectedOptions.map(option => [option.name, option.value]).sort() : null]) : null,
    }];
  });
  const alertIds = exceptions.flatMap(exception => exception.alertId === null ? [] : [exception.alertId]);
  if (actionable && exceptions.length === 0) alertIds.push(alertId(bindingId, ['PRODUCT', [...comparison.issues].sort()]));
  const alerts = store.recordPostHextomAlerts(binding, alertIds, clock());
  return {
    ...context, status, productionAudit, title: current.title, updatedAt: current.updatedAt, hasAdjustTag: comparison.hasAdjustTag,
    optionNames: comparison.optionNames, variantCount: comparison.variantCount, skuCounts: comparison.counts,
    issues: verified ? comparison.issues : ['UNVERIFIED_SOURCE_ASSIGNMENT', ...comparison.issues], exceptions, alerts,
  };
}
