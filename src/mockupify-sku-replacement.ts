import { isDeepStrictEqual } from 'node:util';
import type { MasterInputSkuRow } from './google-sheets.js';
import { mockupifyCorrelation } from './mockupify-preparation.js';
import type { parseExportDetail } from './mockupify-readonly.js';
import { mockupifyInitialSku } from './mockupify-writer-model.js';
import type { MockupifyClaim, MockupifyJournal } from './mockupify-writer-model.js';
import { WorkerError } from './model.js';
import type { ProductBinding } from './product-bindings.js';
import { protectedUntil } from './production-schedule.js';
import { masterInput } from './sheets.js';
import { adjustTag, readStableShopifyProduct, shopifyGid } from './shopify-readonly.js';
import type { ProductRead, ShopifyReadonlyClient } from './shopify-readonly.js';
import { findMasterInputSkuRow } from './shopify-reconciliation.js';
import type { Store } from './store.js';

function settled(claim: MockupifyClaim | undefined) {
  return claim?.state === 'acknowledged' || claim?.state === 'recovered';
}

function verifiedExport(binding: ProductBinding, { journal, history }: ReturnType<Store['inspectMockupifyJournal']>,
  { batchName, designReference, correlationId }: ReturnType<typeof mockupifyCorrelation>) {
  const { plan, claims, batchId, designId, exportId } = journal;
  const { correlation, source, review } = plan;
  const batch = claims.create_batch?.request;
  const upload = claims.upload_design?.request;
  const start = claims.start_export?.request;
  const sourceMatches = correlation.correlationId === correlationId && correlation.batchName === batchName &&
    correlation.designReference === designReference && correlation.spreadsheetId === binding.spreadsheetId &&
    correlation.sourceRow === binding.rowNumber && correlation.productSku === binding.productSku &&
    correlation.artworkSku === binding.artworkSku && source.sourceRow === binding.rowNumber &&
    source.productSku === binding.productSku && source.artworkSku === binding.artworkSku && review.shop.id === binding.shopId;
  const claimsMatch = settled(claims.create_batch) && settled(claims.upload_design) && settled(claims.start_export) &&
    batch?.operation === 'create_batch' && batch.json.name === batchName &&
    upload?.operation === 'upload_design' && upload.fields.batch === batchId && upload.fields.design_id === designReference &&
    start?.operation === 'start_export' && start.json.batch === batchId && claims.start_export?.designId === designId &&
    isDeepStrictEqual(start.json.colors, correlation.mockupifyColorIds);
  const observation = history.findLast(event => event && typeof event === 'object' && 'event' in event &&
    event.event === 'mockupify_export_read' && 'detail' in event) as { detail: ReturnType<typeof parseExportDetail> } | undefined;
  const detail = observation?.detail;
  const product = detail?.products?.[0];
  const observationMatches = detail?.id === exportId && detail?.status === 'finished' && detail.errors?.length === 0 &&
    detail.batch?.id === batchId && detail.batch?.name === batchName && detail.products?.length === 1 &&
    product?.status === 'created' && product.shopifyProductGid === binding.productId && product.design?.id === designId &&
    product.design.designReference === designReference && product.product?.id === correlation.mockupifyTemplateId && Array.isArray(product.colorIds) &&
    isDeepStrictEqual([...product.colorIds].sort(), [...correlation.mockupifyColorIds].sort());
  if (plan.mode !== 'production' || journal.registrationState === 'pending_review' || !journal.exportTerminal ||
    journal.exportStatus !== 'validated_for_binding_review' || journal.publicationObserved ||
    journal.shopifyProductGid !== binding.productId || !isDeepStrictEqual(journal.observedProductGids, [binding.productId]) ||
    batchId === null || designId === null || exportId === null || !sourceMatches || !claimsMatch || !observationMatches) {
    throw new WorkerError('MOCKUPIFY_PROVENANCE_REQUIRED', 'The binding must match a verified, finished Mockupify export and its settled operation claims.');
  }
  return { correlationId, batchId, designId, exportId };
}

function optionPair(options: Record<string, string>) {
  const { Color, Size } = options;
  if (Object.keys(options).length !== 2 || !Color?.trim() || !Size?.trim()) {
    throw new WorkerError('SKU_REPLACEMENT_OPTIONS', 'Every variant must have exactly one Color and one Size with nonblank values.');
  }
  return { color: Color, size: Size, key: JSON.stringify([Color, Size]) };
}

function mapVariants(product: ProductRead, expected: MockupifyJournal['plan']['review']['product']['variants'],
  designId: number, targetSku: string) {
  const colorOption = product.options.find(option => option.position === 1 && option.name === 'Color');
  const sizeOption = product.options.find(option => option.position === 2 && option.name === 'Size');
  if (product.options.length !== 2 || !colorOption || !sizeOption) {
    throw new WorkerError('SKU_REPLACEMENT_OPTIONS', 'Shopify must have Color at option position 1 and Size at position 2.');
  }
  const pairs = new Set(expected?.map(variant => optionPair(variant.options).key));
  if (!expected?.length || pairs.size !== expected.length || product.variants.length !== expected.length) {
    throw new WorkerError('SKU_REPLACEMENT_VARIANTS', 'The live product must contain the complete reviewed set of variants.');
  }
  const ids = new Set<string>();
  const skus = new Set<string>();
  return product.variants.map(variant => {
    const variantId = shopifyGid(variant.id, 'ProductVariant');
    const { color, size, key } = optionPair(Object.fromEntries(variant.selectedOptions.map(option => [option.name, option.value])));
    if (variant.selectedOptions.length !== 2 || !colorOption.values.includes(color) || !sizeOption.values.includes(size) ||
      ids.has(variantId) || !pairs.delete(key) || (variant.sku !== null && skus.has(variant.sku))) {
      throw new WorkerError('SKU_REPLACEMENT_VARIANTS', 'The product has duplicate or unexpected variant IDs, options, or SKUs.');
    }
    const expectedSku = mockupifyInitialSku(designId, color, size);
    if (variant.sku === targetSku || variant.sku === `${targetSku}-${color}-${size}`) {
      throw new WorkerError('SKU_REPLACEMENT_STAGE_CHANGED', 'A variant already has the base SKU or its Hextom-transformed SKU.');
    }
    if (variant.sku !== expectedSku) {
      throw new WorkerError('SKU_REPLACEMENT_UNEXPECTED_SKU', 'Every current SKU must exactly match its verified Mockupify design, Color, and Size.');
    }
    ids.add(variantId);
    skus.add(variant.sku);
    return { variantId, color, size, currentSku: variant.sku, targetSku };
  });
}

export async function previewMockupifySkuReplacement(
  store: Pick<Store, 'getProductBinding' | 'getMockupifyJournal' | 'inspectMockupifyJournal'>, bindingId: string,
  evidence: { shopId: string; shopify: Pick<ShopifyReadonlyClient, 'product'>; readMasterInput: () => Promise<MasterInputSkuRow[]> },
  clock = Date.now,
) {
  const binding = store.getProductBinding(bindingId);
  if (binding.status !== 'approved' || !binding.confirmation) {
    throw new WorkerError('SKU_REPLACEMENT_APPROVAL_REQUIRED', 'An approved product binding with recorded owner confirmation is required.');
  }
  if (evidence.shopId !== binding.shopId) throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The binding is for a different Shopify shop.');
  if (binding.spreadsheetId !== masterInput.spreadsheetId) {
    throw new WorkerError('SOURCE_SHEET_MISMATCH', 'The binding must refer to Design Input Master.');
  }
  const correlation = mockupifyCorrelation(binding.spreadsheetId, binding.productSku);
  const { correlationId } = correlation;
  const record = store.inspectMockupifyJournal(correlationId);
  const { journal } = record;
  const provenance = verifiedExport(binding, record, correlation);
  const checkSource = async () => {
    const rows = await evidence.readMasterInput();
    if (findMasterInputSkuRow({ kind: 'live', rows }, binding, binding.rowNumber).status !== 'MATCHED') {
      throw new WorkerError('SKU_REPLACEMENT_SOURCE_CHANGED', 'The exact Product SKU and Artwork SKU must still match one live Master Input row.');
    }
  };
  await checkSource();
  const product = await readStableShopifyProduct(evidence.shopify, binding.productId);
  if (!product) throw new WorkerError('SHOPIFY_PRODUCT_CHANGED', 'Shopify changed during the complete product reads.');
  if (product.id !== binding.productId) throw new WorkerError('SHOPIFY_PRODUCT_MISMATCH', 'Shopify returned a different product GID.');
  if (product.status !== 'ACTIVE' || !product.tags.includes(adjustTag)) {
    throw new WorkerError('SKU_REPLACEMENT_STAGE_CHANGED', 'An Active product with the exact lowercase adjust tag is required.');
  }
  const variants = mapVariants(product, journal.plan.review.product.variants, provenance.designId, binding.productSku);
  if (!isDeepStrictEqual(product, binding.shopifySnapshot)) {
    throw new WorkerError('SKU_REPLACEMENT_BINDING_DRIFT', 'The live Shopify product differs from the approved binding snapshot.');
  }
  await checkSource();
  if (!isDeepStrictEqual(store.getProductBinding(bindingId), binding) ||
    store.getMockupifyJournal(correlationId).revision !== journal.revision) {
    throw new WorkerError('SKU_REPLACEMENT_BINDING_DRIFT', 'The binding or export journal changed during the preview.');
  }
  const checkedAt = clock();
  const until = protectedUntil(checkedAt);
  const eligibility = until === undefined ? 'ELIGIBLE_FOR_REVIEW' : 'DEFERRED_PROTECTED_WINDOW';
  return {
    mode: 'read_only', executionAuthorized: false, status: eligibility, checkedAt,
    futureWritesProtectedUntil: until === undefined ? null : new Date(until).toISOString(),
    bindingId, shopId: binding.shopId, productId: binding.productId, rowNumber: binding.rowNumber,
    productSku: binding.productSku, artworkSku: binding.artworkSku, provenance,
    variantCount: variants.length, variants: variants.map(variant => ({ ...variant, eligibility })),
  };
}
