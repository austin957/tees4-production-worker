import { integer, object, onlyKeys, requiredText } from './config.js';
import type { MasterInputSkuRow } from './google-sheets.js';
import { WorkerError } from './model.js';
import { masterInput } from './sheets.js';
import { verifyHextom } from './shopify-hextom.js';
import { shopifyGid } from './shopify-readonly.js';
import type { ProductRead } from './shopify-readonly.js';

export interface ReconciliationRequest {
  productId: string;
  productSku: string;
  artworkSku: string;
  evidenceReference: string;
  rowNumber?: number;
}

export interface VerifiedSource {
  kind: 'master_input' | 'mockupify_export';
  reference: string;
  shopId: string;
  productId: string;
  productSku: string;
  artworkSku: string;
  rowNumber?: number;
}

export type SheetEvidence = { kind: 'live'; rows: readonly MasterInputSkuRow[] }
  | { kind: 'fixture'; reference: string; rows: readonly MasterInputSkuRow[] }
  | { kind: 'unavailable'; code: string; message: string };

function sheetIdentity(value: Record<string, unknown>): void {
  if (value.spreadsheetId !== masterInput.spreadsheetId || value.tab !== masterInput.tab) {
    throw new WorkerError('SOURCE_SHEET_MISMATCH', 'The evidence must refer to the Design Input Master spreadsheet and its Master Input tab.');
  }
}

export function parseVerifiedSource(input: unknown): VerifiedSource {
  const value = object(input, 'Verified source record');
  onlyKeys(value, ['kind', 'reference', 'shopId', 'productId', 'productSku', 'artworkSku', 'masterInput'], 'Verified source record');
  if (value.kind !== 'master_input' && value.kind !== 'mockupify_export') {
    throw new WorkerError('INVALID_SOURCE_RECORD', 'Use a verified Master Input or Mockupify export record. Fixture data is not verified source evidence.');
  }
  let rowNumber: number | undefined;
  if (value.masterInput !== undefined) {
    const row = object(value.masterInput, 'Verified source row');
    onlyKeys(row, ['spreadsheetId', 'tab', 'rowNumber'], 'Verified source row');
    sheetIdentity(row);
    rowNumber = integer(row.rowNumber, 'Verified source row number', 1, Number.MAX_SAFE_INTEGER);
  }
  if (value.kind === 'master_input' && rowNumber === undefined) {
    throw new WorkerError('INVALID_SOURCE_RECORD', 'A verified Master Input record requires the physical row.');
  }
  return {
    kind: value.kind, reference: requiredText(value.reference, 'Source evidence reference'),
    shopId: shopifyGid(value.shopId, 'Shop'), productId: shopifyGid(value.productId, 'Product'),
    productSku: requiredText(value.productSku, 'Source Product SKU'), artworkSku: requiredText(value.artworkSku, 'Source Artwork SKU'),
    ...(rowNumber === undefined ? {} : { rowNumber }),
  };
}

export function parseSheetFixture(input: unknown): SheetEvidence {
  const value = object(input, 'Source sheet fixture');
  onlyKeys(value, ['provenance', 'rows'], 'Source sheet fixture');
  const provenance = object(value.provenance, 'Fixture provenance');
  onlyKeys(provenance, ['kind', 'reference', 'spreadsheetId', 'tab'], 'Fixture provenance');
  sheetIdentity(provenance);
  if (provenance.kind !== 'fixture' || !Array.isArray(value.rows)) {
    throw new WorkerError('INVALID_SOURCE_FIXTURE', 'Supply a sanitized fixture with explicit fixture provenance and a rows array.');
  }
  const seen = new Set<number>();
  const rows = (value.rows as unknown[]).map(entry => {
    const row = object(entry, 'Fixture row');
    onlyKeys(row, ['rowNumber', 'productSku', 'artworkSku'], 'Fixture row');
    const rowNumber = integer(row.rowNumber, 'Fixture row number', 1, Number.MAX_SAFE_INTEGER);
    if (seen.has(rowNumber)) throw new WorkerError('DUPLICATE_SHEET_ROW', 'The fixture repeats a physical row number.');
    seen.add(rowNumber);
    return { rowNumber, productSku: row.productSku === null ? null : requiredText(row.productSku, 'Fixture Product SKU'),
      artworkSku: row.artworkSku === null ? null : requiredText(row.artworkSku, 'Fixture Artwork SKU') };
  });
  return { kind: 'fixture', reference: requiredText(provenance.reference, 'Fixture provenance reference'), rows };
}

function sheetFinding(source: SheetEvidence, request: ReconciliationRequest, expectedRow?: number) {
  if (source.kind === 'unavailable') {
    return { status: 'UNAVAILABLE' as const, source: source.kind, authoritative: false, code: source.code, message: source.message };
  }
  const productRows = source.rows.filter(row => row.productSku === request.productSku);
  const artworkRows = source.rows.filter(row => row.artworkSku === request.artworkSku);
  const matchingRows = productRows.filter(row => row.artworkSku === request.artworkSku);
  const onlyMatch = matchingRows.length === 1 ? matchingRows[0] : undefined;
  let status: 'PRODUCT_SKU_NOT_FOUND' | 'CONFLICTING_ASSIGNMENT' | 'ROW_MISMATCH' | 'MATCHED' = 'MATCHED';
  if (!productRows.length) status = 'PRODUCT_SKU_NOT_FOUND';
  else if (productRows.length !== 1 || !onlyMatch) status = 'CONFLICTING_ASSIGNMENT';
  else if (expectedRow !== undefined && onlyMatch.rowNumber !== expectedRow) status = 'ROW_MISMATCH';
  return {
    status, source: source.kind, authoritative: source.kind === 'live',
    ...(source.kind === 'fixture' ? { reference: source.reference } : {}),
    productSkuRows: productRows.map(row => row.rowNumber), artworkSkuRows: artworkRows.map(row => row.rowNumber),
    matchingRows: matchingRows.map(row => row.rowNumber), rowNumber: status === 'MATCHED' ? onlyMatch?.rowNumber : undefined,
  };
}

export function reconcileShopifySource(
  request: ReconciliationRequest, shopId: string, product: ProductRead, sheet: SheetEvidence, verifiedSource?: VerifiedSource,
) {
  if (product.id !== request.productId) throw new WorkerError('SHOPIFY_PRODUCT_MISMATCH', 'The retrieved product does not match the requested GID.');
  const masterInputFinding = sheetFinding(sheet, request, request.rowNumber ?? verifiedSource?.rowNumber);
  const recordMatches = verifiedSource !== undefined
    && verifiedSource.shopId === shopId && verifiedSource.productId === request.productId
    && verifiedSource.productSku === request.productSku && verifiedSource.artworkSku === request.artworkSku
    && verifiedSource.reference === request.evidenceReference
    && (request.rowNumber === undefined || verifiedSource.rowNumber === undefined || verifiedSource.rowNumber === request.rowNumber);
  const liveConflict = masterInputFinding.authoritative && masterInputFinding.status !== 'MATCHED';
  const verified = recordMatches && !(verifiedSource?.kind === 'master_input' && liveConflict);
  const exactSourceSkuCount = product.variants.filter(row => row.sku === request.productSku).length;
  const candidate = exactSourceSkuCount > 0 || ('matchingRows' in masterInputFinding && masterInputFinding.matchingRows.length > 0);
  const status = verified ? 'VERIFIED' : candidate ? 'CANDIDATE' : 'MISSING_EVIDENCE';
  const hextom = verifyHextom(product, verified ? request.productSku : undefined);

  const issues: string[] = [];
  if (!verifiedSource) issues.push('MISSING_VERIFIED_SOURCE_RECORD');
  else if (!recordMatches) issues.push('VERIFIED_SOURCE_MISMATCH');
  else if (!verified) issues.push('VERIFIED_MASTER_INPUT_RECORD_CONFLICT');
  if (masterInputFinding.status !== 'MATCHED') issues.push(`MASTER_INPUT_${masterInputFinding.status}`);
  else if (!masterInputFinding.authoritative) issues.push('MASTER_INPUT_FIXTURE_ONLY');

  let verifiedRow: number | undefined;
  if (!liveConflict && verified) {
    if (masterInputFinding.authoritative && masterInputFinding.status === 'MATCHED') verifiedRow = masterInputFinding.rowNumber;
    else if (verifiedSource?.kind === 'master_input') verifiedRow = verifiedSource.rowNumber;
  }
  const variantIds = product.variants.flatMap(variant => variant.id === null ? [] : [variant.id]);
  const completeVariantIds = variantIds.length > 0 && variantIds.length === product.variants.length
    && new Set(variantIds).size === variantIds.length;
  if (!completeVariantIds) issues.push('SHOPIFY_VARIANT_IDS_INCOMPLETE_OR_DUPLICATE');
  const proposedBinding = verifiedRow !== undefined && completeVariantIds ? {
    status: 'OWNER_REVIEW_REQUIRED',
    shopId, productId: product.id, variantIds, spreadsheetId: masterInput.spreadsheetId, tab: masterInput.tab,
    rowNumber: verifiedRow, artworkSku: request.artworkSku, productSku: request.productSku,
    evidenceReference: request.evidenceReference,
    ...(verifiedSource?.kind === 'mockupify_export' ? { mockupifyExportRef: verifiedSource.reference } : {}),
  } : null;
  return {
    status, issues, source: request, verifiedSourceKind: verified ? verifiedSource?.kind : null,
    shopify: { shopId, productId: product.id, title: product.title, tags: product.tags,
      productStatus: product.status, variantCount: product.variants.length, exactSourceSkuCount },
    masterInput: masterInputFinding, hextom, proposedBinding,
  };
}
