import assert from 'node:assert/strict';
import test from 'node:test';
import { readJson } from '../src/config.js';
import { readMasterInputMatchRows } from '../src/google-sheets.js';
import { masterInput } from '../src/sheets.js';
import { matchShopifyProducts, parseMatchFixture, parseOwnerConfirmations } from '../src/shopify-matching.js';
import type { ProductRead } from '../src/shopify-readonly.js';

const shop = 'gid://shopify/Shop/1';
const id = 'gid://shopify/Product/2';
const product: ProductRead = {
  id, title: 'Fixture Product', vendor: 'Fixture Vendor', productType: 'Tee', status: 'ACTIVE', tags: ['adjust', 'Nurses'],
  handle: 'fixture-product', createdAt: '2026-11-24T12:00:00Z', updatedAt: '2026-11-24T12:00:00Z', publishedAt: null,
  options: [{ id: 'color', position: 1, name: 'Color', values: ['Black', 'White'] },
    { id: 'size', position: 2, name: 'Size', values: ['5X-Large'] }],
  variants: ['White', 'Black'].map((color, index) => ({
    id: `gid://shopify/ProductVariant/${index + 1}`, sku: '000710',
    selectedOptions: [{ name: 'Color', value: color }, { name: 'Size', value: '5X-Large' }],
  })),
};
const fixture = parseMatchFixture(readJson('examples/matching-sheet-fixture.json', 'matching fixture'));
assert.equal(fixture.kind, 'fixture');
if (fixture.kind !== 'fixture') throw new Error('Expected a fixture.');
const row = fixture.rows[0]!;
const live = { kind: 'live' as const, rows: [row] };
const confirmations = parseOwnerConfirmations([{
  spreadsheetId: masterInput.spreadsheetId, rowNumber: 2, productSku: '000710', artworkSku: '00042',
  shopId: shop, productId: id, confirmedBy: 'Fixture Owner',
}]);

test('reads exact physical Master Input rows and preserved SKU leading zeros using formatted read-only values', async () => {
  const rows = await readMasterInputMatchRows(4, async url => {
    assert.equal(url.origin, 'https://sheets.googleapis.com');
    assert.equal(decodeURIComponent(url.pathname), `/v4/spreadsheets/${masterInput.spreadsheetId}/values/'Master Input'!B4:K`);
    assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
    return { values: [
      ['Product Title', '', 'Vendor', 'Product / garment selection', 'Colors', 'Tags', 'Product SKU', 'Tees-4 Completed', '', 'Artwork SKU'],
      [], ['Fixture Product', '', 'Fixture Vendor', 'Tee', 'White, Black', 'Nurses', '000710', 'Yes', '', '00042'],
      ['', '', '', '', '', '', '000711', '', '', ''],
    ] };
  });
  assert.deepEqual(rows, [{ ...row, rowNumber: 6, completion: 'Yes' }, {
    rowNumber: 7, title: null, vendor: null, garment: null, colors: null, tags: null, completion: null,
    productSku: '000711', artworkSku: null,
  }]);
});

test('ranks an exact multi-signal match above a title candidate without confirming either', () => {
  const weaker = { ...row, rowNumber: 3, garment: 'Hoodie', colors: 'Gray', productSku: 'different',
    artworkSku: '00043', vendor: null, tags: null };
  const report = matchShopifyProducts(shop, { ...live, rows: [weaker, row] }, [product]);
  const ranked = report.products[0]!;
  assert.equal(ranked.status, 'CANDIDATES');
  assert.deepEqual(ranked.candidates.map(candidate => [candidate.row.rowNumber, candidate.confidence]), [[2, 'high'], [3, 'low']]);
  assert.deepEqual(ranked.candidates[0]?.signals.map(signal => signal.code), [
    'TITLE_MATCH', 'VENDOR_MATCH', 'GARMENT_MATCH', 'COLORS_MATCH', 'TAG_OVERLAP', 'EXACT_INITIAL_SKU_MATCH',
  ]);
  assert.deepEqual(ranked.candidates[1]?.issues, ['CONFLICTING_VARIANT_SKUS']);
  assert.deepEqual(report.confirmationResults, []);
  const skuOnly = matchShopifyProducts(shop, { ...live, rows: [
    { ...weaker, productSku: '000710', title: 'Different' },
  ] }, [product]);
  assert.equal(skuOnly.products[0]?.candidates[0]?.confidence, 'low');
});

test('detects ambiguous titles and two products competing for the same top row', () => {
  const blank = { ...product, variants: product.variants.map(variant => ({ ...variant, sku: null })) };
  const other = { ...row, rowNumber: 3, productSku: '000711' };
  const tied = matchShopifyProducts(shop, { ...live, rows: [row, other] }, [blank]);
  assert.equal(tied.products[0]?.status, 'AMBIGUOUS');
  const duplicateProducts = matchShopifyProducts(shop, live, [blank, { ...blank, id: 'gid://shopify/Product/3' }]);
  assert.ok(duplicateProducts.products.every(item => item.status === 'AMBIGUOUS'));
  assert.ok(duplicateProducts.products.every(item => item.candidates[0]?.issues.includes('ROW_IS_TOP_MATCH_FOR_MULTIPLE_PRODUCTS')));
});

test('a proposed binding requires explicit confirmation, a matching live row, shop and unique variant IDs', () => {
  const report = matchShopifyProducts(shop, live, [product], confirmations);
  assert.deepEqual(report.confirmationResults[0]?.issues, []);
  assert.deepEqual(report.confirmationResults[0]?.proposedBinding, {
    ...confirmations[0], tab: 'Master Input', variantIds: product.variants.map(variant => variant.id), status: 'OWNER_REVIEW_REQUIRED',
  });
  for (const sheet of [fixture, { kind: 'unavailable' as const, code: 'GOOGLE_AUTH_UNAVAILABLE', message: 'unavailable' }]) {
    const unverified = matchShopifyProducts(shop, sheet, [product], confirmations);
    assert.ok(unverified.confirmationResults[0]?.issues.includes('LIVE_MASTER_INPUT_REQUIRED'));
    assert.equal(unverified.confirmationResults[0]?.proposedBinding, null);
  }
  const missing = matchShopifyProducts(shop, { ...live, rows: [] }, [product], confirmations);
  assert.equal(missing.products[0]?.status, 'NO_CANDIDATES');
  assert.ok(missing.confirmationResults[0]?.issues.includes('MASTER_INPUT_ROW_NOT_FOUND'));
  assert.equal(missing.confirmationResults[0]?.proposedBinding, null);
  const noTag = matchShopifyProducts(shop, live, [{ ...product, tags: ['ADJUST'] }], confirmations);
  assert.equal(noTag.discoveredCount, 0);
  assert.ok(noTag.confirmationResults[0]?.proposedBinding);
});

test('blocks conflicting SKUs, reused Shopify GIDs and duplicate assignments even after confirmation', () => {
  const wrong = { ...product, variants: product.variants.map(variant => ({ ...variant, sku: 'changed-elsewhere' })) };
  const duplicate = { ...row, rowNumber: 3, artworkSku: '00043' };
  const confirmed = confirmations[0]!;
  for (const [inputSheet, products, input, issue] of [
    [live, [wrong], confirmations, 'CONFLICTING_VARIANT_SKUS'],
    [live, [product, product], confirmations, 'DUPLICATE_SHOPIFY_PRODUCT'],
    [live, [product, { ...product, id: 'gid://shopify/Product/3' }], confirmations, 'MULTIPLE_PRODUCTS_SHARE_SOURCE_SKU'],
    [{ ...live, rows: [row, duplicate] }, [product], confirmations, 'DUPLICATE_SHEET_PRODUCT_SKU'],
    [live, [product], [confirmed, { ...confirmed, rowNumber: 3 }], 'DUPLICATE_OWNER_ASSIGNMENT'],
    [live, [product], [{ ...confirmed, artworkSku: 'different' }], 'MASTER_INPUT_SKU_MISMATCH'],
    [live, [product], [{ ...confirmed, shopId: 'gid://shopify/Shop/9' }], 'SHOP_ID_MISMATCH'],
  ] as const) {
    const checked = matchShopifyProducts(shop, inputSheet, products, input).confirmationResults[0];
    assert.ok(checked?.issues.includes(issue));
    assert.equal(checked?.proposedBinding, null);
  }
});

test('ranks an exact transformed pattern without using it as proof or modifying the observed SKU', () => {
  const transformed = { ...product, variants: product.variants.map(variant => ({
    ...variant, sku: `000710-${variant.selectedOptions[0]?.value}-5X-Large`,
  })) };
  const result = matchShopifyProducts(shop, live, [transformed]);
  const match = result.products[0]?.candidates[0];
  assert.equal(match?.sku, 'transformed_pattern_match');
  assert.ok(match?.signals.some(signal => signal.code === 'EXACT_TRANSFORMATION_PATTERN'));
  assert.equal(transformed.variants[0]?.sku, '000710-White-5X-Large');
  assert.deepEqual(result.confirmationResults, []);
});
