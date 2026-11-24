import { integer, object, onlyKeys, requiredText } from './config.js';
import type { MasterInputMatchRow } from './google-sheets.js';
import { WorkerError } from './model.js';
import { masterInput } from './sheets.js';
import { verifyHextom } from './shopify-hextom.js';
import { adjustTag, shopifyGid } from './shopify-readonly.js';
import type { ProductRead } from './shopify-readonly.js';

export type MatchSheet = { kind: 'live'; rows: readonly MasterInputMatchRow[] }
  | { kind: 'fixture'; reference: string; rows: readonly MasterInputMatchRow[] }
  | { kind: 'unavailable'; code: string; message: string };

export interface OwnerConfirmation {
  spreadsheetId: string;
  rowNumber: number;
  productSku: string;
  artworkSku: string;
  shopId: string;
  productId: string;
  confirmedBy: string;
}

export function sharesOwnerAssignment(
  first: Pick<OwnerConfirmation, 'rowNumber' | 'productId' | 'productSku'>, second: OwnerConfirmation,
): boolean {
  return first.rowNumber === second.rowNumber || first.productId === second.productId || first.productSku === second.productSku;
}

function physicalRow(value: unknown): number {
  return integer(value, 'Physical Master Input row', 1, Number.MAX_SAFE_INTEGER);
}

export function parseOwnerConfirmations(input: unknown): OwnerConfirmation[] {
  if (!Array.isArray(input) || !input.length) throw new WorkerError('INVALID_CONFIRMATION', 'Supply a nonempty array of owner confirmations.');
  return (input as unknown[]).map(entry => {
    const row = object(entry, 'Owner confirmation');
    onlyKeys(row, ['spreadsheetId', 'rowNumber', 'productSku', 'artworkSku', 'shopId', 'productId', 'confirmedBy'], 'Owner confirmation');
    if (row.spreadsheetId !== masterInput.spreadsheetId) {
      throw new WorkerError('SOURCE_SHEET_MISMATCH', 'The confirmation must identify Design Input Master.');
    }
    return {
      spreadsheetId: row.spreadsheetId, rowNumber: physicalRow(row.rowNumber),
      productSku: requiredText(row.productSku, 'Confirmed Product SKU'), artworkSku: requiredText(row.artworkSku, 'Confirmed Artwork SKU'),
      shopId: shopifyGid(row.shopId, 'Shop'), productId: shopifyGid(row.productId, 'Product'),
      confirmedBy: requiredText(row.confirmedBy, 'Confirming owner'),
    };
  });
}

export function parseMatchFixture(input: unknown): MatchSheet {
  const value = object(input, 'Matching fixture');
  onlyKeys(value, ['provenance', 'rows'], 'Matching fixture');
  const provenance = object(value.provenance, 'Matching fixture provenance');
  onlyKeys(provenance, ['kind', 'reference', 'spreadsheetId', 'tab'], 'Matching fixture provenance');
  if (provenance.kind !== 'fixture' || provenance.spreadsheetId !== masterInput.spreadsheetId
    || provenance.tab !== masterInput.tab || !Array.isArray(value.rows)) {
    throw new WorkerError('INVALID_SOURCE_FIXTURE', 'Use a sanitized fixture identifying the Master Input tab and its rows.');
  }
  const seen = new Set<number>();
  const text = (value: unknown): string | null => value === null ? null : requiredText(value, 'Fixture cell');
  const rows = (value.rows as unknown[]).map(entry => {
    const row = object(entry, 'Matching fixture row');
    onlyKeys(row, ['rowNumber', 'title', 'vendor', 'garment', 'colors', 'tags', 'completion', 'productSku', 'artworkSku'], 'Matching fixture row');
    const rowNumber = physicalRow(row.rowNumber);
    if (seen.has(rowNumber)) throw new WorkerError('DUPLICATE_SHEET_ROW', 'The fixture repeats a physical row.');
    seen.add(rowNumber);
    return {
      rowNumber, title: text(row.title), vendor: text(row.vendor), garment: text(row.garment), colors: text(row.colors),
      tags: text(row.tags), completion: text(row.completion), productSku: text(row.productSku), artworkSku: text(row.artworkSku),
    };
  });
  return { kind: 'fixture', reference: requiredText(provenance.reference, 'Fixture reference'), rows };
}

const normalized = (value: string | null) => value?.trim().replace(/\s+/gu, ' ').toLowerCase() ?? '';
const tokens = (value: string | null) => new Set((value ?? '').split(',').map(normalized).filter(Boolean));

type SkuSignal = 'unavailable' | 'blank' | 'initial_match' | 'transformed_pattern_match' | 'conflict';

function skuSignal(row: MasterInputMatchRow, product: ProductRead): SkuSignal {
  if (!row.productSku || !product.variants.length) return 'unavailable';
  const populated = product.variants.map(variant => variant.sku).filter(sku => sku !== null && sku !== '');
  if (!populated.length) return 'blank';
  if (populated.every(sku => sku === row.productSku)) return 'initial_match';
  // Only compare the shape here. The candidate SKU is still unverified.
  const verification = verifyHextom(product, row.productSku);
  return verification.status === 'VERIFIED_COMPLETE' ? 'transformed_pattern_match' : 'conflict';
}

function evidence(row: MasterInputMatchRow, product: ProductRead) {
  const title = normalized(row.title);
  const vendor = normalized(row.vendor);
  const garment = normalized(row.garment);
  const colorOptions = product.options.filter(option => ['color', 'colour'].includes(normalized(option.name)));
  const productColors = new Set((colorOptions.length === 1 ? colorOptions[0]!.values : []).map(normalized).filter(Boolean));
  const rowColors = tokens(row.colors);
  const productTags = new Set(product.tags.filter(tag => tag !== adjustTag).map(normalized));
  const sharedTags = [...tokens(row.tags)].filter(tag => productTags.has(tag) && tag !== adjustTag);
  return [
    { code: 'TITLE_MATCH', points: 4, match: !!title && title === normalized(product.title) },
    { code: 'VENDOR_MATCH', points: 1, match: !!vendor && vendor === normalized(product.vendor) },
    { code: 'GARMENT_MATCH', points: 3, match: !!garment && garment === normalized(product.productType) },
    { code: 'COLORS_MATCH', points: 2, match: !!rowColors.size && rowColors.size === productColors.size
      && [...rowColors].every(color => productColors.has(color)) },
    { code: 'TAG_OVERLAP', points: 1, match: sharedTags.length > 0 },
  ].filter(signal => signal.match);
}

function occurrences<T>(items: readonly T[], value: (item: T) => string | null) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = value(item);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function matchShopifyProducts(
  shopId: string, sheet: MatchSheet, products: readonly ProductRead[], confirmations: readonly OwnerConfirmation[] = [],
) {
  const rows = sheet.kind === 'unavailable' ? [] : sheet.rows;
  const rowSkus = occurrences(rows, row => row.productSku);
  const productIds = occurrences(products, product => product.id);
  const productsById = new Map(products.map(product => [product.id, product]));
  const rowsByNumber = new Map(rows.map(row => [row.rowNumber, row]));
  const discoveredSkuOwners = new Map<string, Set<string>>();
  for (const product of products) {
    for (const variant of product.variants) {
      if (!variant.sku) continue;
      const owners = discoveredSkuOwners.get(variant.sku) ?? new Set<string>();
      owners.add(product.id);
      discoveredSkuOwners.set(variant.sku, owners);
    }
  }
  const matchConflicts = (row: MasterInputMatchRow, product: ProductRead, sku: SkuSignal) => {
    const issues: string[] = [];
    if (!row.productSku?.trim() || !row.artworkSku?.trim()) issues.push('MISSING_SOURCE_SKU');
    if (row.productSku && (rowSkus.get(row.productSku) ?? 0) > 1) issues.push('DUPLICATE_SHEET_PRODUCT_SKU');
    if ((productIds.get(product.id) ?? 0) > 1) issues.push('DUPLICATE_SHOPIFY_PRODUCT');
    if (row.productSku && (discoveredSkuOwners.get(row.productSku)?.size ?? 0) > 1) issues.push('MULTIPLE_PRODUCTS_SHARE_SOURCE_SKU');
    if (sku === 'conflict') issues.push('CONFLICTING_VARIANT_SKUS');
    return issues;
  };

  const ranked = products.filter(product => product.tags.includes(adjustTag)).map(product => {
    const candidates = rows.flatMap(row => {
      const signals = evidence(row, product);
      const codes = signals.map(signal => signal.code);
      const hasExactSku = row.productSku !== null && discoveredSkuOwners.get(row.productSku)?.has(product.id);
      if (!hasExactSku && !codes.includes('TITLE_MATCH') && !(codes.includes('GARMENT_MATCH')
        && (codes.includes('COLORS_MATCH') || codes.includes('TAG_OVERLAP')))) return [];
      const sku = skuSignal(row, product);
      if (sku === 'initial_match') signals.push({ code: 'EXACT_INITIAL_SKU_MATCH', points: 5, match: true });
      if (sku === 'transformed_pattern_match') signals.push({ code: 'EXACT_TRANSFORMATION_PATTERN', points: 5, match: true });
      const issues = matchConflicts(row, product, sku);
      const score = signals.reduce((total, signal) => total + signal.points, 0);
      const confidence = issues.length || signals.length < 2 ? 'low' : score >= 9 ? 'high' : 'medium';
      return [{ row, signals, sku, issues, score, confidence }];
    }).sort((a, b) => Number(Boolean(a.issues.length)) - Number(Boolean(b.issues.length))
      || b.score - a.score || a.row.rowNumber - b.row.rowNumber);
    const top = candidates[0];
    const tied = !!top && candidates.some((candidate, index) =>
      index > 0 && candidate.score === top.score && Boolean(candidate.issues.length) === Boolean(top.issues.length));
    return {
      product: { id: product.id, title: product.title, tags: product.tags, vendor: product.vendor,
        productType: product.productType, status: product.status, variantCount: product.variants.length,
        observedSkuValues: [...new Set(product.variants.map(variant => variant.sku))] },
      status: sheet.kind === 'unavailable' ? 'SOURCE_UNAVAILABLE' : tied ? 'AMBIGUOUS' : top ? 'CANDIDATES' : 'NO_CANDIDATES',
      candidates,
    };
  });

  const topRows = occurrences(ranked, entry => {
    const top = entry.candidates[0];
    return entry.status === 'CANDIDATES' && top && !top.issues.length ? String(top.row.rowNumber) : null;
  });
  for (const entry of ranked) {
    const top = entry.candidates[0];
    if (top && (topRows.get(String(top.row.rowNumber)) ?? 0) > 1) {
      entry.status = 'AMBIGUOUS';
      top.issues.push('ROW_IS_TOP_MATCH_FOR_MULTIPLE_PRODUCTS');
      top.confidence = 'low';
    }
  }
  const confirmationResults = confirmations.map(confirmation => {
    const product = productsById.get(confirmation.productId);
    const row = rowsByNumber.get(confirmation.rowNumber);
    const issues: string[] = [];
    if (sheet.kind !== 'live') issues.push('LIVE_MASTER_INPUT_REQUIRED');
    if (confirmation.shopId !== shopId) issues.push('SHOP_ID_MISMATCH');
    if (!row) issues.push('MASTER_INPUT_ROW_NOT_FOUND');
    else if (row.productSku !== confirmation.productSku || row.artworkSku !== confirmation.artworkSku) issues.push('MASTER_INPUT_SKU_MISMATCH');
    if (!product) issues.push('SHOPIFY_PRODUCT_NOT_FOUND');
    if (confirmations.filter(other => sharesOwnerAssignment(confirmation, other)).length > 1) issues.push('DUPLICATE_OWNER_ASSIGNMENT');
    const variantIds = product?.variants.map(variant => variant.id) ?? [];
    if (row && product) {
      issues.push(...matchConflicts(row, product, skuSignal(row, product)));
      if (!variantIds.length || variantIds.some(id => id === null) || new Set(variantIds).size !== variantIds.length) {
        issues.push('INCOMPLETE_OR_DUPLICATE_VARIANT_IDS');
      }
    }
    return { confirmation, issues, proposedBinding: issues.length ? null : { ...confirmation, tab: masterInput.tab, variantIds, status: 'OWNER_REVIEW_REQUIRED' } };
  });

  return {
    shopId, masterInput: sheet.kind === 'unavailable' ? sheet
      : { source: sheet.kind, rowCount: rows.length, authoritative: sheet.kind === 'live',
        ...(sheet.kind === 'fixture' ? { reference: sheet.reference } : {}) },
    status: sheet.kind === 'unavailable' ? 'MASTER_INPUT_UNAVAILABLE' : 'CANDIDATE_REPORT',
    discoveredCount: ranked.length, products: ranked, confirmationResults,
  };
}
