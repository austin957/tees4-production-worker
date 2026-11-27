import assert from 'node:assert/strict';
import test from 'node:test';
import { readJson } from '../src/config.js';
import { readMasterInputSkuRows } from '../src/google-sheets.js';
import { masterInput } from '../src/sheets.js';
import { parseSheetFixture, parseVerifiedSource, reconcileShopifySource } from '../src/shopify-reconciliation.js';
import type { ProductRead } from '../src/shopify-readonly.js';

const shopId = 'gid://shopify/Shop/1';
const request = {
  productId: 'gid://shopify/Product/2', productSku: '000710', artworkSku: '00042',
  evidenceReference: 'fixture-export-record', rowNumber: 2,
};
const product: ProductRead = {
  id: request.productId, title: 'Fixture', status: 'ACTIVE', tags: ['adjust'],
  handle: 'fixture', vendor: 'Fixture Vendor', productType: 'Tee', publishedAt: null,
  createdAt: '2026-11-24T12:00:00Z', updatedAt: '2026-11-24T12:00:00Z',
  options: [
    { id: 'fixture-color', position: 1, name: 'Color', values: ['White', 'Black'] },
    { id: 'fixture-size', position: 2, name: 'Size', values: ['5X-Large'] },
  ],
  variants: ['White', 'Black'].map((color, index) => ({
    id: `gid://shopify/ProductVariant/${index + 1}`, sku: request.productSku,
    selectedOptions: [{ name: 'Color', value: color }, { name: 'Size', value: '5X-Large' }],
  })),
};
const live = { kind: 'live' as const, rows: [{ rowNumber: 2, artworkSku: request.artworkSku, productSku: request.productSku }] };
const unavailable = { kind: 'unavailable' as const, code: 'GOOGLE_AUTH_UNAVAILABLE', message: 'Test blocked.' };
const exportRecord = {
  kind: 'mockupify_export', reference: request.evidenceReference, shopId,
  productId: request.productId, productSku: request.productSku, artworkSku: request.artworkSku,
};

test('reads only the H–K range and preserves exact displayed SKUs and physical row numbers', async () => {
  const rows = await readMasterInputSkuRows(3, async url => {
    assert.equal(url.origin, 'https://sheets.googleapis.com');
    assert.equal(decodeURIComponent(url.pathname), `/v4/spreadsheets/${masterInput.spreadsheetId}/values/'Master Input'!H3:K`);
    assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
    return { values: [['Product SKU', 'Tees-4 Completed', '', 'Artwork SKU'], [], ['000710', '', '', '00042']] };
  });
  assert.deepEqual(rows, [
    { rowNumber: 4, productSku: null, artworkSku: null },
    { rowNumber: 5, productSku: '000710', artworkSku: '00042' },
  ]);
  await assert.rejects(readMasterInputSkuRows(1, async () => ({ values: [['Artwork SKU', '', '', 'Product SKU']] })), {
    code: 'SHEET_HEADER_MISMATCH',
  });
});

test('the observed Shopify SKU, reference text, and even a live matching row do not bind Shopify to the source', () => {
  for (const sheet of [unavailable, live]) {
    const result = reconcileShopifySource(request, shopId, product, sheet);
    assert.equal(result.status, 'CANDIDATE');
    assert.equal(result.shopify.exactSourceSkuCount, 2);
    assert.equal(result.hextom.status, 'NEEDS_RECONCILIATION');
    assert.equal(result.proposedBinding, null);
  }
  const noSupport = reconcileShopifySource({ ...request, productSku: 'different' }, shopId, product, unavailable);
  assert.equal(noSupport.status, 'MISSING_EVIDENCE');
});

test('sanitized fixture provenance never supplies authoritative row or product identity evidence', () => {
  const input = readJson('examples/reconciliation-sheet-fixture.json', 'fixture');
  const fixture = parseSheetFixture(input);
  const candidate = reconcileShopifySource(request, shopId, product, fixture);
  assert.equal(candidate.status, 'CANDIDATE');
  assert.equal(candidate.masterInput.status, 'MATCHED');
  assert.equal(candidate.masterInput.authoritative, false);
  assert.equal(candidate.hextom.verifiedBaseSku, null);
  assert.equal(candidate.proposedBinding, null);
  const sourceOnly = reconcileShopifySource(request, shopId, product, fixture, parseVerifiedSource(exportRecord));
  assert.equal(sourceOnly.status, 'VERIFIED');
  assert.equal(sourceOnly.proposedBinding, null);
  assert.throws(() => parseVerifiedSource({ ...exportRecord, kind: 'fixture' }), { code: 'INVALID_SOURCE_RECORD' });
});

test('an exact trusted record verifies the base and offers a review-only proposal with a live row', () => {
  const source = parseVerifiedSource(exportRecord);
  const updated = {
    ...product,
    variants: product.variants.map(variant => ({
      ...variant, sku: `${request.productSku}-${variant.selectedOptions[0]?.value}-5X-Large`,
    })),
  };
  const result = reconcileShopifySource(request, shopId, updated, live, source);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.hextom.status, 'VERIFIED_COMPLETE');
  assert.equal(result.shopify.exactSourceSkuCount, 0);
  assert.equal(result.masterInput.status, 'MATCHED');
  assert.deepEqual(result.proposedBinding, {
    status: 'OWNER_REVIEW_REQUIRED', shopId, productId: request.productId,
    variantIds: product.variants.map(variant => variant.id),
    spreadsheetId: masterInput.spreadsheetId, tab: masterInput.tab, rowNumber: 2,
    artworkSku: request.artworkSku, productSku: request.productSku,
    evidenceReference: request.evidenceReference, mockupifyExportRef: request.evidenceReference,
  });
  const unavailableResult = reconcileShopifySource(request, shopId, product, unavailable, source);
  assert.equal(unavailableResult.hextom.status, 'PENDING_HEXTOM');
  assert.equal(unavailableResult.status, 'VERIFIED');
  assert.equal(unavailableResult.proposedBinding, null);
  const absent = reconcileShopifySource(request, shopId, product, { ...live, rows: [] }, source);
  assert.equal(absent.masterInput.status, 'PRODUCT_SKU_NOT_FOUND');
  assert.equal(absent.proposedBinding, null);
});

test('conflicting or missing live rows and record mismatches cannot create a proposal', () => {
  const record = parseVerifiedSource({ ...exportRecord, kind: 'master_input', masterInput: {
    spreadsheetId: masterInput.spreadsheetId, tab: masterInput.tab, rowNumber: 2,
  } });
  const reviewedExtract = reconcileShopifySource(request, shopId, product, unavailable, record);
  assert.equal(reviewedExtract.proposedBinding?.rowNumber, 2);

  for (const [input, expected] of [
    [{ ...live, rows: [] }, 'PRODUCT_SKU_NOT_FOUND'],
    [{ ...live, rows: [{ ...live.rows[0]!, rowNumber: 3 }] }, 'ROW_MISMATCH'],
    [{ ...live, rows: [...live.rows, { ...live.rows[0]!, rowNumber: 3, artworkSku: 'different' }] }, 'CONFLICTING_ASSIGNMENT'],
  ] as const) {
    const result = reconcileShopifySource(request, shopId, product, input, record);
    assert.equal(result.masterInput.status, expected);
    assert.equal(result.status, 'CANDIDATE');
    assert.equal(result.hextom.verifiedBaseSku, null);
    assert.equal(result.proposedBinding, null);
  }
  for (const mismatched of [
    { ...record, shopId: 'gid://shopify/Shop/98' }, { ...record, productId: 'gid://shopify/Product/98' },
    { ...record, artworkSku: 'different' }, { ...record, productSku: 'different' },
    { ...record, reference: 'different' }, { ...record, rowNumber: 3 },
  ]) {
    const result = reconcileShopifySource(request, shopId, product, live, mismatched);
    assert.equal(result.verifiedSourceKind, null);
    assert.ok(result.issues.includes('VERIFIED_SOURCE_MISMATCH'));
    assert.equal(result.proposedBinding, null);
  }
});

test('duplicate or missing Shopify variant IDs block a proposal even with verified source and row', () => {
  for (const variants of [[], [product.variants[0]!, product.variants[0]!], [{ ...product.variants[0]!, id: null }]]) {
    const result = reconcileShopifySource(request, shopId, { ...product, variants }, live, parseVerifiedSource(exportRecord));
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.hextom.status, 'MANUAL_REVIEW');
    assert.equal(result.proposedBinding, null);
  }
});
