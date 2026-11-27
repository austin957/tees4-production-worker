import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { previewMockupifySkuReplacement } from '../src/mockupify-sku-replacement.js';
import { mockupifyOperations } from '../src/mockupify-writer-model.js';
import { masterInput } from '../src/sheets.js';
import type { ProductRead } from '../src/shopify-readonly.js';
import { Store } from '../src/store.js';
import { FakeMockupify, initialTime, input, png, productGid, review, shop } from './mockupify-writer-fixture.js';

const colors = ['Black', 'White'];
const sizes = ['X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large'];
const initialSkus = [
  '70253-Black-X-Small', '70253-Black-Small', '70253-Black-Medium', '70253-Black-Large',
  '70253-Black-X-Large', '70253-Black-2X-Large', '70253-Black-3X-Large',
  '70253-White-X-Small', '70253-White-Small', '70253-White-Medium', '70253-White-Large',
  '70253-White-X-Large', '70253-White-2X-Large', '70253-White-3X-Large',
];
const assignment = {
  spreadsheetId: masterInput.spreadsheetId, rowNumber: 9, productSku: input.source.productSku!,
  artworkSku: input.source.artworkSku!, shopId: shop.id, productId: productGid,
};
const sourceRow = { rowNumber: 9, productSku: assignment.productSku, artworkSku: assignment.artworkSku };

function databasePath(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'tees4-sku-replacement-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return join(path, 'worker.sqlite');
}

async function seed(store: Store, approve = true) {
  const api = new FakeMockupify();
  api.designId = 70253;
  const variants = colors.flatMap(Color => sizes.map(Size => ({ options: { Color, Size }, price: '18.99' })));
  for (const color of api.catalog.find(template => template.id === 10779)!.colors) {
    color.sizes = sizes;
    color.price = '18.99';
  }
  api.shopifyVariants = variants;
  api.shopifySkus = initialSkus;
  const writer = api.writer(store);
  const { correlationId } = (await writer.prepare(input, { ...review, product: { ...review.product, variants } }, png)).plan.correlation;
  for (const operation of mockupifyOperations) {
    await writer.dispatch(correlationId, operation, api.approve(store, correlationId, operation), png);
  }
  api.finish();
  const journal = await writer.reconcile(correlationId);
  assert.equal(journal.exportStatus, 'validated_for_binding_review');
  // Build persisted production-shaped evidence using only simulated provider calls.
  store.updateMockupifyJournal({ ...journal, plan: { ...journal.plan, mode: 'production' } }, { event: 'fixture' });
  const snapshot: ProductRead = {
    id: productGid, title: review.product.title, handle: 'fixture', status: 'ACTIVE', vendor: review.product.vendor,
    tags: review.product.tags, productType: 'Tank Top', publishedAt: null,
    createdAt: new Date(initialTime).toISOString(), updatedAt: new Date(initialTime).toISOString(),
    options: [{ id: 'fixture-color', name: 'Color', position: 1, values: colors },
      { id: 'fixture-size', name: 'Size', position: 2, values: sizes }],
    variants: variants.map(({ options }, index) => ({
      id: `gid://shopify/ProductVariant/${index + 8}`, sku: initialSkus[index]!,
      selectedOptions: Object.entries(options).map(([name, value]) => ({ name, value })),
    })),
  };
  const binding = store.createProductBinding(assignment, 'Fixture operator', snapshot, initialTime);
  if (approve) store.recordProductBindingReview(binding.id, {
    event: 'approved', by: 'Fixture owner', at: initialTime + 1, source: 'Fixture export evidence',
  });
  return { id: binding.id, correlationId, snapshot };
}

function liveEvidence(snapshot: ProductRead) {
  return { shopId: shop.id, shopify: { async product() { return structuredClone(snapshot); } },
    async readMasterInput() { return [sourceRow]; } };
}

test('maps the complete pilot SKU pattern from the approved binding and leaves the SQLite records intact', async t => {
  const path = databasePath(t);
  const store = new Store(path);
  t.after(() => store.close());
  const { id, correlationId, snapshot } = await seed(store);
  const before = [store.inspectProductBinding(id), store.inspectMockupifyJournal(correlationId)];
  const reader = new Store(path, { readOnly: true });
  t.after(() => reader.close());
  const preview = await previewMockupifySkuReplacement(reader, id, liveEvidence(snapshot), () => initialTime);
  assert.equal(preview.mode, 'read_only');
  assert.equal(preview.executionAuthorized, false);
  assert.equal(preview.variantCount, 14);
  assert.deepEqual(preview.provenance, { correlationId, batchId: 71, designId: 70253, exportId: 301 });
  assert.deepEqual(preview.variants, snapshot.variants.map((variant, index) => ({
    variantId: variant.id, color: colors[Math.floor(index / sizes.length)], size: sizes[index % sizes.length],
    currentSku: initialSkus[index], targetSku: assignment.productSku, eligibility: 'ELIGIBLE_FOR_REVIEW',
  })));
  assert.deepEqual([store.inspectProductBinding(id), store.inspectMockupifyJournal(correlationId)], before);
});

test('holds preview eligibility from 4:20 PM inclusive until 9:10 PM exclusive in Chicago', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { id, snapshot } = await seed(store);
  for (const [timestamp, deferred] of [
    ['2026-11-27T22:19:59Z', false], ['2026-11-27T22:20:00Z', true],
    ['2026-11-28T03:09:59Z', true], ['2026-11-28T03:10:00Z', false],
  ] as const) {
    const preview = await previewMockupifySkuReplacement(store, id, liveEvidence(snapshot), () => Date.parse(timestamp));
    assert.equal(preview.status, deferred ? 'DEFERRED_PROTECTED_WINDOW' : 'ELIGIBLE_FOR_REVIEW');
    assert.equal(preview.futureWritesProtectedUntil, deferred ? '2026-11-28T03:10:00.000Z' : null);
    assert.ok(preview.variants.every(variant => variant.eligibility === preview.status));
    assert.equal(preview.executionAuthorized, false);
  }
});

test('rejects mismatched provenance and unapproved bindings before provider reads', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { id, correlationId, snapshot } = await seed(store, false);
  const evidence = { ...liveEvidence(snapshot), async readMasterInput(): Promise<never> { return assert.fail('No provider reads expected'); } };
  const preview = () => previewMockupifySkuReplacement(store, id, evidence);
  await assert.rejects(preview(), { code: 'SKU_REPLACEMENT_APPROVAL_REQUIRED' });
  store.recordProductBindingReview(id, { event: 'approved', by: 'Fixture owner', at: initialTime, source: 'Fixture export' });
  const journal = store.getMockupifyJournal(correlationId);
  for (const change of [
    { exportStatus: 'held' as const }, { designId: 70254 }, { exportId: 302 }, { exportId: null },
    { shopifyProductGid: 'gid://shopify/Product/3' },
    { observedProductGids: [productGid, 'gid://shopify/Product/3'] },
    { plan: { ...journal.plan, source: { ...journal.plan.source, productSku: 'wrong-sku' } } },
  ]) {
    store.updateMockupifyJournal({ ...journal, ...change, revision: store.getMockupifyJournal(correlationId).revision }, { event: 'fixture' });
    await assert.rejects(preview(), { code: 'MOCKUPIFY_PROVENANCE_REQUIRED' });
  }
});

test('rejects drift, duplicates, missing variants, unexpected SKUs, and mixed or completed Hextom stages', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { id, snapshot } = await seed(store);
  const rejectChange = (edit: (product: ProductRead) => void, code: string) => {
    const changed = structuredClone(snapshot);
    edit(changed);
    return assert.rejects(previewMockupifySkuReplacement(store, id, liveEvidence(changed)), { code });
  };
  await rejectChange(product => { product.id = 'gid://shopify/Product/3'; }, 'SHOPIFY_PRODUCT_MISMATCH');
  await rejectChange(product => { product.title = 'Changed title'; }, 'SKU_REPLACEMENT_BINDING_DRIFT');
  await rejectChange(product => { product.variants[0]!.id = 'gid://shopify/ProductVariant/99'; }, 'SKU_REPLACEMENT_BINDING_DRIFT');
  await rejectChange(product => { product.variants[0]!.id = product.variants[1]!.id; }, 'SKU_REPLACEMENT_VARIANTS');
  await rejectChange(product => { product.variants[1]!.sku = product.variants[0]!.sku; }, 'SKU_REPLACEMENT_VARIANTS');
  await rejectChange(product => { product.variants[1]!.selectedOptions = product.variants[0]!.selectedOptions; }, 'SKU_REPLACEMENT_VARIANTS');
  await rejectChange(product => { product.variants.pop(); }, 'SKU_REPLACEMENT_VARIANTS');
  await rejectChange(product => { product.options[0]!.position = 2; }, 'SKU_REPLACEMENT_OPTIONS');
  await rejectChange(product => { product.variants[0]!.selectedOptions[0]!.name = 'Colour'; }, 'SKU_REPLACEMENT_OPTIONS');
  await rejectChange(product => { product.tags = ['ADJUST']; }, 'SKU_REPLACEMENT_STAGE_CHANGED');
  for (const sku of [null, '', '70254-Black-X-Small', '70253-black-X-Small']) {
    await rejectChange(product => { product.variants[0]!.sku = sku; }, 'SKU_REPLACEMENT_UNEXPECTED_SKU');
  }
  for (const sku of [assignment.productSku, `${assignment.productSku}-Black-X-Small`]) {
    await rejectChange(product => { product.variants[0]!.sku = sku; }, 'SKU_REPLACEMENT_STAGE_CHANGED');
  }
  await rejectChange(product => {
    for (const variant of product.variants) variant.sku = assignment.productSku;
  }, 'SKU_REPLACEMENT_STAGE_CHANGED');
});

test('fails closed when Shopify, the source row, or the approved binding changes during the preview', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { id, snapshot } = await seed(store);
  let reads = 0;
  await assert.rejects(previewMockupifySkuReplacement(store, id, {
    ...liveEvidence(snapshot), shopify: { async product() {
      const current = structuredClone(snapshot);
      if (++reads === 2) current.variants[0]!.sku = `${assignment.productSku}-Black-X-Small`;
      return current;
    } },
  }), { code: 'SHOPIFY_PRODUCT_CHANGED' });
  assert.equal(reads, 2);

  reads = 0;
  await assert.rejects(previewMockupifySkuReplacement(store, id, {
    ...liveEvidence(snapshot), async readMasterInput() {
      return ++reads === 1 ? [sourceRow] : [sourceRow, { ...sourceRow, rowNumber: 10 }];
    },
  }), { code: 'SKU_REPLACEMENT_SOURCE_CHANGED' });

  reads = 0;
  await assert.rejects(previewMockupifySkuReplacement(store, id, {
    ...liveEvidence(snapshot), async readMasterInput() {
      if (++reads === 2) store.recordProductBindingReview(id, {
        event: 'stale', review: 'recheck', by: 'Fixture operator', at: initialTime + 2, code: 'FIXTURE_DRIFT',
      });
      return [sourceRow];
    },
  }), { code: 'SKU_REPLACEMENT_BINDING_DRIFT' });
});

test('preview CLI rejects execute and requires an existing SQLite database', t => {
  const path = databasePath(t);
  const run = (...args: string[]) => spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', 'dist/src/cli.js', 'mockupify-sku-replacement-preview', 'fixture-binding', ...args,
  ], { encoding: 'utf8', env: { ...process.env, TEES4_DATABASE: path } });
  const execute = run('--execute');
  assert.equal(execute.status, 1);
  assert.match(execute.stderr, /CLI_USAGE/);
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /DATABASE_OPEN/);
  assert.equal(existsSync(path), false);
});
