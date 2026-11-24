import { isDeepStrictEqual } from 'node:util';
import type { MasterInputProductionRow } from './google-sheets.js';
import { WorkerError } from './model.js';
import { verifyHextom } from './shopify-hextom.js';
import { reconcileShopifySource } from './shopify-reconciliation.js';
import type { SheetEvidence, VerifiedSource } from './shopify-reconciliation.js';
import type { ProductRead, ShopifyReadonlyClient } from './shopify-readonly.js';

type ProductionStage = 'SKU_PREPARATION_IN_PROGRESS' | 'READY_FOR_HEXTOM' | 'HEXTOM_PROCESSING_OR_PENDING'
  | 'VERIFIED_COMPLETE' | 'NEEDS_RECONCILIATION' | 'MANUAL_REVIEW';

type ProductionSheet = { kind: 'live'; rows: readonly MasterInputProductionRow[] }
  | Extract<SheetEvidence, { kind: 'unavailable' }>;

type AuditSource = { verifiedSource: VerifiedSource; sheet: ProductionSheet }
  | { candidateBaseSku?: string };
type Hextom = ReturnType<typeof verifyHextom>;

function preparingSkus(hextom: Hextom): boolean {
  const { counts, hasAdjustTag, issues, variantCount } = hextom;
  return hasAdjustTag && variantCount > 0
    && (counts.INITIAL > 0 || counts.MISSING_SKU === variantCount)
    && counts.MISSING_SKU + counts.UNEXPECTED_SKU > 0
    && issues.every(issue => ['MISSING_SKUS', 'UNEXPECTED_SKUS', 'DUPLICATE_NON_BASE_SKUS'].includes(issue));
}

function verifiedStage(hextom: Hextom): ProductionStage {
  if (hextom.status === 'VERIFIED_COMPLETE') {
    return hextom.hasAdjustTag ? 'HEXTOM_PROCESSING_OR_PENDING' : 'VERIFIED_COMPLETE';
  }
  if (hextom.status === 'PENDING_HEXTOM') return 'READY_FOR_HEXTOM';
  if (preparingSkus(hextom)) return 'SKU_PREPARATION_IN_PROGRESS';
  if (hextom.hasAdjustTag && hextom.issues.length === 1 && hextom.issues[0] === 'PARTIALLY_TRANSFORMED') {
    return 'HEXTOM_PROCESSING_OR_PENDING';
  }
  return 'MANUAL_REVIEW';
}

function sourceEvidence(source: AuditSource, shopId: string, product: ProductRead) {
  if (!('verifiedSource' in source)) {
    return { verifiedBaseSku: undefined, candidateBaseSku: source.candidateBaseSku, masterInput: null,
      sourceIssues: ['MISSING_VERIFIED_SOURCE_RECORD'] };
  }
  const { verifiedSource: record, sheet } = source;
  const reconciliation = reconcileShopifySource({
    productId: product.id, productSku: record.productSku, artworkSku: record.artworkSku,
    evidenceReference: record.reference, ...(record.rowNumber === undefined ? {} : { rowNumber: record.rowNumber }),
  }, shopId, product, sheet, record);
  const finding = reconciliation.masterInput;
  const liveMatch = finding.authoritative && finding.status === 'MATCHED';
  const row = liveMatch && sheet.kind === 'live' ? sheet.rows.find(item => item.rowNumber === finding.rowNumber) : undefined;
  const verified = reconciliation.status === 'VERIFIED'
    && (liveMatch || (!finding.authoritative && record.kind === 'master_input'));
  return {
    verifiedBaseSku: verified ? record.productSku : undefined, candidateBaseSku: undefined,
    masterInput: {
      status: liveMatch ? 'MATCHED' : finding.status, rowNumber: row?.rowNumber ?? record.rowNumber ?? null,
      completion: row?.completion ?? null, completionAvailable: row !== undefined,
      ...(sheet.kind === 'unavailable' ? { code: sheet.code } : {}),
    },
    sourceIssues: verified ? [] : [...reconciliation.issues, 'MASTER_INPUT_BINDING_UNVERIFIED'],
  };
}

function stageReport(shopId: string, product: ProductRead, source: AuditSource) {
  const evidence = sourceEvidence(source, shopId, product);
  const { verifiedBaseSku, candidateBaseSku, masterInput, sourceIssues } = evidence;
  // A candidate is used only to describe observed strings, with no authority to verify a stage.
  const comparison = verifyHextom(product, verifiedBaseSku ?? candidateBaseSku);
  const status = verifiedBaseSku === undefined ? 'NEEDS_RECONCILIATION' : verifiedStage(comparison);
  const observedStage = status === 'NEEDS_RECONCILIATION' && comparison.counts.INITIAL > 0 && preparingSkus(comparison)
    ? 'SKU_PREPARATION_IN_PROGRESS' : null;
  const issues = [...new Set([...sourceIssues, ...comparison.issues])];
  if (!verifiedBaseSku && candidateBaseSku) issues.push('UNVERIFIED_CANDIDATE_BASE_SKU');
  if (status === 'HEXTOM_PROCESSING_OR_PENDING' && comparison.status === 'VERIFIED_COMPLETE') {
    issues.push('AWAITING_ADJUST_TAG_REMOVAL');
  }
  const markedPrepared = masterInput?.completion?.trim().toLowerCase() === 'yes';
  if (markedPrepared && status === 'SKU_PREPARATION_IN_PROGRESS') issues.push('COLUMN_I_YES_WITH_PREPARATION_EXCEPTIONS');
  if (masterInput?.completionAvailable && !markedPrepared && status === 'READY_FOR_HEXTOM') {
    issues.push('COLUMN_I_NOT_MARKED_YES');
  }
  const includeInitial = comparison.counts.TRANSFORMED > 0 && comparison.counts.INITIAL > 0;
  return {
    status, observedStage, issues, shopId, productId: product.id, title: product.title, updatedAt: product.updatedAt,
    tags: product.tags, hasAdjustTag: comparison.hasAdjustTag, variantCount: comparison.variantCount,
    source: { verifiedBaseSku: verifiedBaseSku ?? null, candidateBaseSku: candidateBaseSku ?? null, masterInput },
    hextomStatus: verifiedBaseSku === undefined ? 'NEEDS_RECONCILIATION' : comparison.status,
    skuCounts: comparison.counts,
    variantFindings: comparison.variants.filter(variant => variant.status === 'INITIAL' ? includeInitial
      : variant.status !== 'TRANSFORMED' && variant.status !== 'UNVERIFIED_BASE').map(variant => ({
        id: variant.id, currentSku: variant.currentSku, options: variant.selectedOptions, status: variant.status,
        expectedFinalSku: verifiedBaseSku === undefined ? null : variant.expectedSku,
      })),
  };
}

export async function auditShopifyProduction(
  client: Pick<ShopifyReadonlyClient, 'product'>, shopId: string, productId: string, source: AuditSource = {},
) {
  let initial: ProductRead | undefined;
  try {
    initial = await client.product(productId);
    const current = await client.product(productId);
    // Include variant data and tags in the comparison even when Shopify reports identical timestamps.
    if (isDeepStrictEqual(initial, current)) return stageReport(shopId, current, source);
  } catch (error) {
    if (!(error instanceof WorkerError) || (error.code !== 'SHOPIFY_PRODUCT_CHANGED'
      && !(initial && error.code === 'SHOPIFY_PRODUCT_NOT_FOUND'))) throw error;
  }
  return { status: 'NEEDS_RECONCILIATION' as const, observedStage: null, shopId, productId, issues: ['SHOPIFY_SNAPSHOT_CHANGED'] };
}
