import assert from 'node:assert/strict';
import test from 'node:test';
import { readMasterInputProductionRows } from '../src/google-sheets.js';
import { WorkerError } from '../src/model.js';
import { auditShopifyProduction } from '../src/shopify-production-audit.js';
import type { ProductRead } from '../src/shopify-readonly.js';
import type { VerifiedSource } from '../src/shopify-reconciliation.js';

const shopId = 'gid://shopify/Shop/1';
const productId = 'gid://shopify/Product/2';
const base = '000710';
const source: VerifiedSource = {
  kind: 'master_input', reference: 'owner-reviewed-fixture', shopId, productId,
  productSku: base, artworkSku: '00042', rowNumber: 4,
};
const unavailable = { kind: 'unavailable' as const, code: 'GOOGLE_AUTH_UNAVAILABLE', message: 'Fixture unavailable.' };
const verified = { verifiedSource: source, sheet: unavailable };
const candidate = { candidateBaseSku: base };
const liveRow = { rowNumber: 4, productSku: base, artworkSku: '00042', completion: 'Yes' };
const finalSlate = base + '-Slate-X-Large';
const finalRed = base + '-Red-X-Large';

function product(skus: (string | null)[], tags = ['adjust']): ProductRead {
  return {
    id: productId, status: 'ACTIVE', title: 'Fixture', tags, handle: 'fixture', vendor: 'Fixture Vendor',
    productType: 'T-Shirt', publishedAt: null, createdAt: '2026-11-24T12:00:00Z', updatedAt: '2026-11-24T12:00:00Z',
    options: [
      { id: 'color', name: 'Color', position: 1, values: ['Slate', 'Red'] },
      { id: 'size', name: 'Size', position: 2, values: ['X-Large'] },
    ],
    variants: skus.map((sku, i) => ({
      id: `gid://shopify/ProductVariant/${i + 1}`, sku,
      selectedOptions: [{ name: 'Size', value: 'X-Large' }, { name: 'Color', value: i === 0 ? 'Slate' : 'Red' }],
    })),
  };
}

async function stable(snapshot: ProductRead, evidence?: Parameters<typeof auditShopifyProduction>[3]) {
  let reads = 0;
  const report = await auditShopifyProduction({
    async product(id) {
      assert.equal(id, productId);
      reads++;
      return structuredClone(snapshot);
    },
  }, shopId, productId, evidence);
  assert.equal(reads, 2);
  assert.ok('skuCounts' in report);
  return report;
}

test('supplier-style and blank variants remain preparation exceptions with a verified base and exact tag', async () => {
  for (const sku of ['supplier-Slate-X-Large', null]) {
    const snapshot = product([sku, base]);
    const report = await stable(snapshot, verified);
    assert.equal(report.status, 'SKU_PREPARATION_IN_PROGRESS');
    assert.equal(report.skuCounts.INITIAL, 1);
    assert.equal(report.variantFindings.length, 1);
    assert.deepEqual(report.variantFindings[0], {
      id: snapshot.variants[0]?.id, currentSku: sku, options: snapshot.variants[0]?.selectedOptions,
      status: sku === null ? 'MISSING_SKU' : 'UNEXPECTED_SKU', expectedFinalSku: finalSlate,
    });
  }
  assert.equal((await stable(product([null, null]), verified)).status, 'SKU_PREPARATION_IN_PROGRESS');
});

test('a supplied SKU supports a preparation observation without authenticating the assignment', async () => {
  const report = await stable(product(['supplier-Slate-X-Large', base]), candidate);
  assert.equal(report.status, 'NEEDS_RECONCILIATION');
  assert.equal(report.observedStage, 'SKU_PREPARATION_IN_PROGRESS');
  assert.equal(report.hextomStatus, 'NEEDS_RECONCILIATION');
  assert.equal(report.source.verifiedBaseSku, null);
  assert.equal(report.skuCounts.INITIAL, 1);
  assert.equal(report.variantFindings[0]?.expectedFinalSku, null);
  for (const skus of [[base, base], [finalSlate, finalRed]]) {
    for (const evidence of [undefined, candidate]) {
      for (const tags of [['adjust'], []]) {
        const unverified = await stable(product(skus, tags), evidence);
        assert.equal(unverified.status, 'NEEDS_RECONCILIATION');
        assert.equal(unverified.observedStage, null);
      }
    }
  }
});

test('readiness requires every SKU to be initial and the exact adjust tag', async () => {
  assert.equal((await stable(product([base, base]), verified)).status, 'READY_FOR_HEXTOM');
  for (const tags of [[], ['Adjust']]) {
    const report = await stable(product([base, base], tags), verified);
    assert.equal(report.status, 'MANUAL_REVIEW');
    assert.ok(report.issues.includes('INITIAL_SKUS_WITHOUT_ADJUST'));
  }
});

test('flags mixed transformations and confirms the entire stage only after tag removal and exact final SKUs', async () => {
  const partial = await stable(product([finalSlate, base]), verified);
  assert.equal(partial.status, 'HEXTOM_PROCESSING_OR_PENDING');
  assert.ok(partial.issues.includes('PARTIALLY_TRANSFORMED'));
  assert.equal(partial.variantFindings[0]?.currentSku, base);
  assert.equal((await stable(product([finalSlate, base], []), verified)).status, 'MANUAL_REVIEW');
  assert.equal((await stable(product([finalSlate, 'wrong-final']), verified)).status, 'MANUAL_REVIEW');
  const awaitingRemoval = await stable(product([finalSlate, finalRed]), verified);
  assert.equal(awaitingRemoval.status, 'HEXTOM_PROCESSING_OR_PENDING');
  assert.equal(awaitingRemoval.hextomStatus, 'VERIFIED_COMPLETE');
  assert.ok(awaitingRemoval.issues.includes('AWAITING_ADJUST_TAG_REMOVAL'));
  assert.equal((await stable(product([finalSlate, finalRed], []), verified)).status, 'VERIFIED_COMPLETE');
});

test('duplicate transformations and duplicate final SKUs require manual review', async () => {
  const repeated = await stable(product([finalSlate + '-Slate-X-Large', base]), verified);
  assert.equal(repeated.status, 'MANUAL_REVIEW');
  assert.equal(repeated.skuCounts.DUPLICATE_TRANSFORMATION, 1);
  assert.equal(repeated.variantFindings[0]?.status, 'DUPLICATE_TRANSFORMATION');
  const duplicate = await stable(product([finalSlate, finalSlate]), verified);
  assert.equal(duplicate.status, 'MANUAL_REVIEW');
  assert.ok(duplicate.issues.includes('DUPLICATE_NON_BASE_SKUS'));
});

test('column I supports the stage and a conflicting live row prevents verification', async () => {
  function withLiveRow(completion: string | null, artworkSku = liveRow.artworkSku) {
    return { verifiedSource: source, sheet: { kind: 'live' as const, rows: [{ ...liveRow, completion, artworkSku }] } };
  }
  const preparation = await stable(product(['supplier', base]), withLiveRow('Yes'));
  assert.equal(preparation.status, 'SKU_PREPARATION_IN_PROGRESS');
  assert.equal(preparation.source.masterInput?.completion, 'Yes');
  assert.ok(preparation.issues.includes('COLUMN_I_YES_WITH_PREPARATION_EXCEPTIONS'));
  const ready = await stable(product([base, base]), withLiveRow(null));
  assert.equal(ready.status, 'READY_FOR_HEXTOM');
  assert.ok(ready.issues.includes('COLUMN_I_NOT_MARKED_YES'));
  assert.equal((await stable(product([base, base], []), withLiveRow('Yes'))).status, 'MANUAL_REVIEW');
  assert.equal((await stable(product([base, base]), withLiveRow('Yes', 'wrong'))).status, 'NEEDS_RECONCILIATION');
  assert.equal((await stable(product([base, base]), {
    ...verified, verifiedSource: { ...source, shopId: 'gid://shopify/Shop/9' },
  })).status, 'NEEDS_RECONCILIATION');

  const exportRecord = { ...source, kind: 'mockupify_export' as const };
  assert.equal((await stable(product([base, base]), { ...verified, verifiedSource: exportRecord })).status, 'NEEDS_RECONCILIATION');
  assert.equal((await stable(product([base, base]), { ...withLiveRow('Yes'), verifiedSource: exportRecord })).status, 'READY_FOR_HEXTOM');
});

test('reads only Master Input H through K and preserves physical rows and column I', async () => {
  const headers = ['Product SKU', 'Tees-4 Completed', '', 'Artwork SKU'];
  const rows = await readMasterInputProductionRows(2, async url => {
    assert.match(decodeURIComponent(url.pathname), /'Master Input'!H2:K$/);
    assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
    return { values: [headers, [], [base, 'Yes', '', '00042']] };
  });
  assert.deepEqual(rows, [{ rowNumber: 3, productSku: null, artworkSku: null, completion: null }, liveRow]);
  await assert.rejects(readMasterInputProductionRows(2, async () => ({
    values: [['Product SKU', 'Other header', '', 'Artwork SKU']],
  })), { code: 'SHEET_HEADER_MISMATCH' });
});

test('fails closed if a Shopify snapshot changes, including data changes with the same timestamp', async () => {
  const first = product([base, base]);
  const current = [
    product([base, base], []), product([finalSlate, base]),
    { ...first, updatedAt: '2026-11-24T12:00:01Z' },
    new WorkerError('SHOPIFY_PRODUCT_CHANGED', 'Updated between pages.'),
    new WorkerError('SHOPIFY_PRODUCT_NOT_FOUND', 'Disappeared.'),
  ];
  for (const second of current) {
    let reads = 0;
    const report = await auditShopifyProduction({ async product() {
      if (++reads === 1) return first;
      if (second instanceof WorkerError) throw second;
      return second;
    } }, shopId, productId, verified);
    assert.equal(reads, 2);
    assert.deepEqual(report, {
      status: 'NEEDS_RECONCILIATION', observedStage: null, shopId, productId, issues: ['SHOPIFY_SNAPSHOT_CHANGED'],
    });
  }
});
