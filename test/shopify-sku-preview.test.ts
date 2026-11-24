import assert from 'node:assert/strict';
import test from 'node:test';
import { masterInput } from '../src/sheets.js';
import { previewShopifySkus } from '../src/shopify-sku-preview.js';
import type { ProductRead } from '../src/shopify-readonly.js';

const binding = {
  shopId: 'gid://shopify/Shop/1', productId: 'gid://shopify/Product/2', rowNumber: 4, productSku: '001-202', artworkSku: '001',
};
const confirmation = { ...binding, spreadsheetId: masterInput.spreadsheetId, confirmedBy: 'Fixture owner' };
const row = { rowNumber: binding.rowNumber, productSku: binding.productSku, artworkSku: binding.artworkSku };
const verified = { confirmations: [confirmation], sheet: { kind: 'live' as const, rows: [row] } };

function product(skus: (string | null)[], tags = ['adjust']): ProductRead {
  return {
    id: binding.productId, title: 'Fixture garment', handle: 'fixture', status: 'ACTIVE', productType: 'T-Shirt',
    vendor: 'Fixture vendor', tags, publishedAt: null, createdAt: '2026-11-24T12:00:00Z', updatedAt: '2026-11-24T12:00:00Z',
    options: [
      { id: 'color', name: 'Colour', position: 1, values: ['Slate', 'Navy', 'White', 'Green'] },
      { id: 'size', name: 'Size', position: 2, values: ['X-Large'] },
    ],
    variants: skus.map((sku, index) => ({
      id: `gid://shopify/ProductVariant/${index + 1}`, sku,
      selectedOptions: [{ name: 'Size', value: 'X-Large' }, { name: 'Colour', value: ['Slate', 'Navy', 'White', 'Green'][index]! }],
    })),
  };
}

async function stable(snapshot: ProductRead, evidence?: Parameters<typeof previewShopifySkus>[3]) {
  let reads = 0;
  const report = await previewShopifySkus({
    async product(id) {
      assert.equal(id, binding.productId);
      reads++;
      return structuredClone(snapshot);
    },
  }, binding.shopId, binding, evidence);
  assert.equal(reads, 2);
  assert.ok('counts' in report);
  return report;
}

test('previews blank SKUs only and preserves unresolved nonblank SKUs during adjust preparation', async () => {
  const supplier = 'supplier-White-X-Large';
  const report = await stable(product([null, binding.productSku, supplier, '  ']), verified);
  assert.equal(report.bindingVerified, true);
  assert.equal(report.status, 'REVIEW_REQUIRED');
  assert.deepEqual(report.counts, { WOULD_ASSIGN: 1, UNCHANGED: 1, NEEDS_REVIEW: 2 });
  assert.deepEqual(report.variants.map(({ variantId, color, size, currentSku, proposedBaseSku, action }) =>
    ({ variantId, color, size, currentSku, proposedBaseSku, action })), [
    { variantId: 'gid://shopify/ProductVariant/1', color: 'Slate', size: 'X-Large', currentSku: null,
      proposedBaseSku: binding.productSku, action: 'WOULD_ASSIGN' },
    { variantId: 'gid://shopify/ProductVariant/2', color: 'Navy', size: 'X-Large', currentSku: binding.productSku,
      proposedBaseSku: null, action: 'UNCHANGED' },
    { variantId: 'gid://shopify/ProductVariant/3', color: 'White', size: 'X-Large', currentSku: supplier,
      proposedBaseSku: null, action: 'NEEDS_REVIEW' },
    { variantId: 'gid://shopify/ProductVariant/4', color: 'Green', size: 'X-Large', currentSku: '  ',
      proposedBaseSku: null, action: 'NEEDS_REVIEW' },
  ]);
  assert.equal((await stable(product(['']), verified)).variants[0]?.action, 'WOULD_ASSIGN');
});

test('diagnostic inputs and fixtures never propose an assignment even with exact SKU evidence', async () => {
  const snapshot = product([binding.productSku, 'supplier-Navy-X-Large', '']);
  const diagnostic = await stable(snapshot);
  assert.equal(diagnostic.status, 'DIAGNOSTIC_ONLY');
  assert.equal(diagnostic.bindingVerified, false);
  assert.deepEqual(diagnostic.counts, { WOULD_ASSIGN: 0, UNCHANGED: 1, NEEDS_REVIEW: 2 });
  const fixture = await stable(snapshot, { ...verified, sheet: { kind: 'fixture', reference: 'synthetic', rows: [row] } });
  assert.equal(fixture.status, 'BLOCKED');
  assert.ok(fixture.issues.includes('LIVE_MASTER_INPUT_REQUIRED'));
  assert.ok(fixture.variants.every(variant => variant.proposedBaseSku === null));
});

test('rejects missing, mismatched and duplicate binding evidence', async () => {
  const otherProduct = { ...confirmation, productId: 'gid://shopify/Product/3' };
  const cases = [
    [{ ...verified, confirmations: [] }, 'MISSING_OWNER_CONFIRMATION'],
    [{ ...verified, confirmations: [otherProduct] }, 'OWNER_CONFIRMATION_MISMATCH'],
    [{ ...verified, confirmations: [{ ...confirmation, shopId: 'gid://shopify/Shop/9' }] }, 'OWNER_CONFIRMATION_MISMATCH'],
    [{ ...verified, confirmations: [confirmation, confirmation] }, 'DUPLICATE_OWNER_ASSIGNMENT'],
    [{ ...verified, confirmations: [confirmation, { ...otherProduct, productSku: 'other' }] }, 'DUPLICATE_OWNER_ASSIGNMENT'],
    [{ ...verified, confirmations: [confirmation, { ...otherProduct, rowNumber: 5 }] }, 'DUPLICATE_OWNER_ASSIGNMENT'],
    [{ ...verified, confirmations: [confirmation, { ...confirmation, rowNumber: 5, productSku: 'other' }] }, 'DUPLICATE_OWNER_ASSIGNMENT'],
    [{ ...verified, sheet: { kind: 'live', rows: [{ ...row, rowNumber: 5 }] } }, 'MASTER_INPUT_ROW_MISMATCH'],
    [{ ...verified, sheet: { kind: 'live', rows: [{ ...row, artworkSku: 'other' }] } }, 'MASTER_INPUT_CONFLICTING_ASSIGNMENT'],
    [{ ...verified, sheet: { kind: 'live', rows: [row, { ...row, rowNumber: 5 }] } }, 'MASTER_INPUT_CONFLICTING_ASSIGNMENT'],
    [{ ...verified, sheet: { kind: 'unavailable', code: 'GOOGLE_AUTH_UNAVAILABLE', message: 'Fixture unavailable.' } },
      'LIVE_MASTER_INPUT_REQUIRED'],
  ] as const;
  for (const [evidence, code] of cases) {
    const report = await stable(product(['']), evidence);
    assert.equal(report.bindingVerified, false);
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.counts.WOULD_ASSIGN, 0);
    assert.ok(report.issues.includes(code));
  }
  await assert.rejects(previewShopifySkus({
    product: async () => assert.fail('Shopify must not be read for the wrong shop'),
  }, 'gid://shopify/Shop/9', binding, verified), { code: 'SHOPIFY_SHOP_MISMATCH' });
});

test('Hextom processing, completed SKUs and removal of the exact tag block all assignments', async () => {
  const transformed = binding.productSku + '-Slate-X-Large';
  for (const [skus, tags, issue] of [
    [[transformed, null], ['adjust'], 'HEXTOM_TRANSFORMATION_PRESENT'],
    [[transformed, binding.productSku + '-Navy-X-Large'], [], 'HEXTOM_TRANSFORMATION_PRESENT'],
    [[transformed + '-Slate-X-Large', null], ['adjust'], 'DUPLICATE_TRANSFORMATIONS'],
    [[binding.productSku + '-unexpected', null], ['adjust'], 'POSSIBLE_HEXTOM_TRANSFORMATION'],
    [[binding.productSku, null], [], 'ADJUST_TAG_MISSING'],
    [[binding.productSku, null], ['Adjust'], 'ADJUST_TAG_MISSING'],
  ] as [Array<string | null>, string[], string][]) {
    const report = await stable(product(skus, tags), verified);
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.counts.WOULD_ASSIGN, 0);
    assert.ok(report.issues.includes(issue));
    assert.ok(report.variants.every(variant => variant.proposedBaseSku === null));
  }
});

test('blocks assignments for duplicate or missing variant IDs and ambiguous options', async () => {
  const duplicate = product([null, null]);
  duplicate.variants[1]!.id = duplicate.variants[0]!.id;
  const missing = product([null, null]);
  missing.variants[0]!.id = null;
  const invalid = product([null, null]);
  invalid.variants[0]!.selectedOptions.pop();
  for (const snapshot of [duplicate, missing, invalid]) {
    const report = await stable(snapshot, verified);
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.counts.NEEDS_REVIEW, 2);
  }
});

test('suppresses the variant plan when any Shopify data changes between complete reads', async () => {
  const first = product([null]);
  for (const second of [product([binding.productSku]), product([null], [])]) {
    let reads = 0;
    const report = await previewShopifySkus({ async product() { return ++reads === 1 ? first : second; } },
      binding.shopId, binding, verified);
    assert.equal(reads, 2);
    assert.equal(report.status, 'BLOCKED');
    assert.deepEqual(report.issues, ['SHOPIFY_SNAPSHOT_CHANGED']);
    assert.deepEqual(report.variants, []);
  }
});
