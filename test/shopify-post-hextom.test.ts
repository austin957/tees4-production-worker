import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { proposeProductBinding, reviewProductBinding } from '../src/product-bindings.js';
import { masterInput } from '../src/sheets.js';
import { reportPostHextom } from '../src/shopify-post-hextom.js';
import type { ProductRead } from '../src/shopify-readonly.js';
import { Store } from '../src/store.js';

const assignment = {
  spreadsheetId: masterInput.spreadsheetId, rowNumber: 4, productSku: '001-202', artworkSku: '001',
  shopId: 'gid://shopify/Shop/1', productId: 'gid://shopify/Product/2',
};
const base = assignment.productSku;
const size = 'X-Large';
const colors = ['Navy', 'Slate', 'Deep-Red', 'White', 'Green', 'Brown'];
const expected = (index: number) => `${base}-${colors[index]}-${size}`;

function product(skus: (string | null)[], tags: string[] = []): ProductRead {
  return {
    id: assignment.productId, title: 'Fixture garment', handle: 'fixture', status: 'ACTIVE', vendor: 'Fixture Vendor',
    productType: 'T-Shirt', publishedAt: null, tags, createdAt: '2026-11-24T12:00:00Z', updatedAt: '2026-11-24T12:00:00Z',
    options: [
      { id: 'size', name: 'Size', position: 2, values: [size] },
      { id: 'color', name: 'Color', position: 1, values: colors },
    ],
    variants: skus.map((sku, index) => ({
      id: `gid://shopify/ProductVariant/${index + 1}`, sku,
      selectedOptions: [{ name: 'Size', value: size }, { name: 'Color', value: colors[index]! }],
    })),
  };
}

function reader(snapshot: ProductRead) {
  return { async product(id: string) { assert.equal(id, assignment.productId); return structuredClone(snapshot); } };
}

async function propose(store: Store) {
  const snapshot = product([base, base], ['adjust']);
  return proposeProductBinding(store, assignment, 'Fixture operator', { shopId: assignment.shopId, shopify: reader(snapshot) });
}

async function report(store: Store, bindingId: string, snapshot: ProductRead, now = 100) {
  const result = await reportPostHextom(store, reader(snapshot), assignment.shopId, bindingId, () => now);
  assert.ok('skuCounts' in result);
  return result;
}

test('proposed bindings expose candidates and diagnose missing, duplicate and conflicting transformed SKUs', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const binding = await propose(store);
  const snapshot = product([
    expected(0), 'supplier-Slate-X-Large-Slate-X-Large', null, expected(3) + '-White-X-Large',
    base + '-X-Large-Green', expected(0),
  ]);
  const result = await report(store, binding.id, snapshot);
  assert.equal(result.status, 'POST_HEXTOM_EXCEPTIONS');
  assert.equal(result.source.verification, 'UNVERIFIED_CANDIDATE');
  assert.equal(result.source.verifiedBaseSku, null);
  assert.equal(result.productionAudit.status, 'NEEDS_RECONCILIATION');
  assert.equal(result.skuCounts.TRANSFORMED, 1);
  assert.equal(result.exceptions.length, 6);
  assert.deepEqual(result.exceptions.map(exception => exception.issues), [
    ['DUPLICATE_CURRENT_SKU'],
    ['CONFLICTING_BASE_SKU', 'REPEATED_OPTION_SUFFIX', 'UNEXPECTED_SKU'],
    ['MISSING_SKU'],
    ['DUPLICATE_TRANSFORMATION'],
    ['INCORRECT_OPTION_SUFFIX', 'UNEXPECTED_SKU'],
    ['DUPLICATE_CURRENT_SKU', 'INCORRECT_OPTION_SUFFIX', 'UNEXPECTED_SKU'],
  ]);
  assert.ok(result.exceptions.every((exception, index) => exception.expectedSku === null
    && exception.expectedSkuCandidate === expected(index) && exception.variantId === snapshot.variants[index]?.id));
  assert.equal(result.alerts.length, 6);
  assert.ok(result.alerts.every(alert => alert.created));
  assert.deepEqual(store.inspectProductBinding(binding.id).history.map(entry => entry.event), ['proposed']);
});

test('distinguishes preparation, pending processing, and tag removal without matching SKUs', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const binding = await propose(store);
  const preparation = await report(store, binding.id, product([base, 'supplier'], ['adjust']));
  assert.equal(preparation.status, 'PRE_HEXTOM_PREPARATION');
  assert.equal(preparation.productionAudit.observedStage, 'SKU_PREPARATION_IN_PROGRESS');
  assert.equal(preparation.exceptions.length, 1);
  assert.deepEqual(preparation.alerts, []);
  const pending = await report(store, binding.id, product([expected(0), base], ['adjust']));
  assert.equal(pending.status, 'HEXTOM_PROCESSING_OR_PENDING');
  assert.deepEqual(pending.alerts, []);
  const awaitingRemoval = await report(store, binding.id, product([expected(0), expected(1)], ['adjust']));
  assert.equal(awaitingRemoval.status, 'HEXTOM_PROCESSING_OR_PENDING');
  const activeExceptions = await report(store, binding.id, product([expected(0), null], ['adjust']));
  assert.equal(activeExceptions.status, 'HEXTOM_EXCEPTIONS_WITH_ADJUST');
  assert.equal(activeExceptions.alerts.length, 1);
  const unconfirmed = await report(store, binding.id, product([base, base], ['Adjust']));
  assert.equal(unconfirmed.status, 'PROCESSING_UNCONFIRMED');
  assert.ok(unconfirmed.exceptions.every(exception => exception.issues.includes('INITIAL_SKU_REMAINS')));
  const matching = await report(store, binding.id, product([expected(0), expected(1)]));
  assert.equal(matching.status, 'CANDIDATE_SKUS_MATCH');
  assert.deepEqual(matching.alerts, []);
});

test('uses approved source values after live SKU changes and verifies completion only with exact values', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const binding = await propose(store);
  await reviewProductBinding(store, binding.id, { action: 'approve', by: 'Fixture owner', source: 'fixture-review' }, {
    shopId: assignment.shopId, shopify: reader(binding.shopifySnapshot),
    async readMasterInput() { return { kind: 'live', rows: [assignment] }; },
  });
  const verified = await report(store, binding.id, product([expected(0), expected(1)]));
  assert.equal(verified.status, 'VERIFIED_COMPLETE');
  assert.equal(verified.source.verification, 'REGISTRY_APPROVED');
  assert.equal(verified.productionAudit.status, 'VERIFIED_COMPLETE');
  assert.deepEqual(verified.exceptions, []);
  const exception = await report(store, binding.id, product([expected(0), null]));
  assert.equal(exception.status, 'POST_HEXTOM_EXCEPTIONS');
  assert.equal(exception.exceptions[0]?.expectedSku, expected(1));
  assert.equal(exception.exceptions[0]?.expectedSkuCandidate, null);
  assert.equal(store.getProductBinding(binding.id).status, 'approved');
});

test('reuses unchanged per-variant alerts across SQLite restarts and records only the changed exception', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tees4-post-hextom-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'worker.sqlite');
  const snapshot = product([expected(0), null, 'supplier']);
  using original = new DisposableStack();
  const first = original.adopt(new Store(path), store => store.close());
  const binding = await propose(first);
  const initial = await report(first, binding.id, snapshot, 100);
  assert.equal(initial.alerts.length, 2);
  assert.ok(initial.alerts.every(alert => alert.created && alert.firstSeenAt === 100));
  original.dispose();
  using restart = new DisposableStack();
  const reopened = restart.adopt(new Store(path), store => store.close());
  const replay = await report(reopened, binding.id, { ...snapshot, title: 'Unrelated title edit', variants: [...snapshot.variants].reverse() }, 200);
  assert.ok(replay.alerts.every(alert => !alert.created && alert.firstSeenAt === 100));
  assert.deepEqual(replay.alerts.map(alert => alert.id).sort(), initial.alerts.map(alert => alert.id).sort());
  const changed = await report(reopened, binding.id, product([expected(0), null, 'different-supplier']), 300);
  assert.equal(changed.alerts.filter(alert => alert.created).length, 1);
  assert.equal(changed.alerts.find(alert => alert.created)?.firstSeenAt, 300);
  const empty = await report(reopened, binding.id, product([]), 400);
  assert.ok(empty.issues.includes('NO_VARIANTS'));
  assert.equal(empty.alerts.length, 1);
  assert.equal((await report(reopened, binding.id, product([]), 500)).alerts[0]?.created, false);
});

test('suppresses findings on Shopify drift and refuses rejected bindings', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const binding = await propose(store);
  let reads = 0;
  const stale = await reportPostHextom(store, {
    async product() { return ++reads === 1 ? product([expected(0), null]) : product([expected(0), expected(1)]); },
  }, assignment.shopId, binding.id);
  assert.equal(reads, 2);
  assert.equal(stale.status, 'NEEDS_RECONCILIATION');
  assert.deepEqual(stale.alerts, []);
  assert.deepEqual(stale.issues, ['SHOPIFY_SNAPSHOT_CHANGED']);
  store.recordProductBindingReview(binding.id, { event: 'rejected', by: 'Fixture owner', at: 100, reason: 'Wrong garment' });
  await assert.rejects(reportPostHextom(store, { async product() { return assert.fail('Unexpected Shopify read'); } },
    assignment.shopId, binding.id), { code: 'BINDING_REPORT_UNAVAILABLE' });
});
