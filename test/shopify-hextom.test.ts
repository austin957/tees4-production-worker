import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyHextom } from '../src/shopify-hextom.js';
import type { ProductRead, ProductVariantRead } from '../src/shopify-readonly.js';

const baseSku = '001-A-202';
const variant = (id: number, sku: string | null, color = 'Dark-Blue', size = '5X-Large'): ProductVariantRead => ({
  id: `gid://shopify/ProductVariant/${id}`, sku,
  selectedOptions: [{ name: 'Size', value: size }, { name: 'Color', value: color }],
});

function product(variants: ProductVariantRead[], tags = ['adjust']): ProductRead {
  return {
    id: 'gid://shopify/Product/2', title: 'Fixture', status: 'ACTIVE', tags,
    handle: 'fixture', vendor: 'Fixture Vendor', publishedAt: null,
    createdAt: '2026-11-24T12:00:00Z', updatedAt: '2026-11-24T12:00:00Z',
    options: [
      { id: 'fixture-size', name: 'Size', position: 2, values: ['5X-Large', 'Small'] },
      { id: 'fixture-color', name: 'Color', position: 1, values: ['Dark-Blue', 'Natural'] },
    ],
    variants,
  };
}

test('uniform initial SKUs with exact adjust are pending and tag removal alone does not prove completion', () => {
  const variants = [variant(1, baseSku), variant(2, baseSku, 'Natural', 'Small')];
  const pending = verifyHextom(product(variants), baseSku);
  assert.equal(pending.status, 'PENDING_HEXTOM');
  assert.equal(pending.counts.INITIAL, 2);
  assert.equal(pending.hasAdjustTag, true);
  assert.deepEqual(pending.duplicateNonBaseSkus, []);
  assert.deepEqual(pending.issues, []);

  for (const tags of [[], ['ADJUST'], ['Adjust']]) {
    const result = verifyHextom(product(variants, tags), baseSku);
    assert.equal(result.status, 'MANUAL_REVIEW');
    assert.equal(result.hasAdjustTag, false);
    assert.deepEqual(result.tags, tags);
    assert.ok(result.issues.includes('INITIAL_SKUS_WITHOUT_ADJUST'));
  }
});

test('verifies exact transformation in Shopify configuration order with or without the tag', () => {
  const transformed = [variant(1, '001-A-202-Dark-Blue-5X-Large'), variant(2, '001-A-202-Natural-Small', 'Natural', 'Small')];
  for (const tags of [[], ['adjust']]) {
    const result = verifyHextom(product(transformed, tags), baseSku);
    assert.equal(result.status, 'VERIFIED_COMPLETE');
    assert.deepEqual(result.optionNames, ['Color', 'Size']);
    assert.equal(result.variants[0]?.expectedSku, '001-A-202-Dark-Blue-5X-Large');
    assert.equal(result.variants[0]?.option2, '5X-Large');
    assert.equal(result.counts.TRANSFORMED, transformed.length);
    assert.deepEqual(result.issues, []);
  }
});

test('flags twice and repeatedly transformed SKUs without parsing on hyphens', () => {
  const suffix = '-Dark-Blue-5X-Large';
  for (const times of [2, 3]) {
    const result = verifyHextom(product([variant(1, baseSku + suffix.repeat(times))]), baseSku);
    assert.equal(result.status, 'MANUAL_REVIEW');
    assert.equal(result.variants[0]?.status, 'DUPLICATE_TRANSFORMATION');
    assert.equal(result.variants[0]?.expectedSku, baseSku + suffix);
    assert.deepEqual(result.issues, ['DUPLICATE_TRANSFORMATIONS']);
  }
});

test('flags partial transformations, missing SKUs and incorrect exact values', () => {
  const result = verifyHextom(product([
    variant(1, '001-A-202-Dark-Blue-5X-Large'),
    variant(2, baseSku, 'Natural', 'Small'),
    variant(3, null, 'Natural', '5X-Large'),
    variant(4, '001-A-202-Small-Dark-Blue', 'Dark-Blue', 'Small'),
  ]), baseSku);
  assert.equal(result.status, 'MANUAL_REVIEW');
  assert.deepEqual(result.variants.map(row => row.status), ['TRANSFORMED', 'INITIAL', 'MISSING_SKU', 'UNEXPECTED_SKU']);
  assert.deepEqual(result.issues, ['MISSING_SKUS', 'UNEXPECTED_SKUS', 'PARTIALLY_TRANSFORMED']);
  for (const sku of ['', '  ', '001-A-202-Dark-Blue-5X-Large ']) {
    assert.equal(verifyHextom(product([variant(1, sku)]), baseSku).status, 'MANUAL_REVIEW');
  }
});

test('requires a trusted base and does not infer one from uniform or transformed values', () => {
  for (const input of [undefined, '', '   ']) {
    const result = verifyHextom(product([variant(1, baseSku), variant(2, baseSku, 'Natural', 'Small')]), input);
    assert.equal(result.status, 'NEEDS_RECONCILIATION');
    assert.equal(result.verifiedBaseSku, null);
    assert.equal(result.counts.UNVERIFIED_BASE, 2);
    assert.ok(result.variants.every(row => row.expectedSku === null));
  }
});

test('flags duplicate final values and collisions or ambiguity in configured options', () => {
  const sharedFinal = `${baseSku}-Dark-Blue-5X-Large`;
  const wrong = verifyHextom(product([variant(1, sharedFinal), variant(2, sharedFinal, 'Natural', 'Small')]), baseSku);
  assert.deepEqual(wrong.duplicateNonBaseSkus, [sharedFinal]);
  assert.equal(wrong.status, 'MANUAL_REVIEW');
  const collision = verifyHextom(product([
    variant(1, `${baseSku}-Red-Dark-Blue`, 'Red-Dark', 'Blue'),
    variant(2, `${baseSku}-Red-Dark-Blue`, 'Red', 'Dark-Blue'),
  ]), baseSku);
  assert.equal(collision.counts.TRANSFORMED, 2);
  assert.deepEqual(collision.duplicateExpectedSkus, [`${baseSku}-Red-Dark-Blue`]);
  assert.equal(collision.status, 'MANUAL_REVIEW');

  const invalid = product([{ ...variant(1, baseSku), selectedOptions: [{ name: 'Color', value: 'Dark-Blue' }] }]);
  assert.ok(verifyHextom(invalid, baseSku).issues.includes('INVALID_VARIANT_OPTIONS'));
  invalid.options[0]!.position = 1;
  assert.ok(verifyHextom(invalid, baseSku).issues.includes('INVALID_OPTION_POSITIONS'));
  assert.equal(verifyHextom(product([]), baseSku).status, 'MANUAL_REVIEW');
});
