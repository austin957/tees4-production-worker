import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { previewMockupifySkuReplacement } from '../src/mockupify-sku-replacement.js';
import { mockupifyOperations } from '../src/mockupify-writer-model.js';
import { masterInput } from '../src/sheets.js';
import { approveSkuReplacement, dryRunSkuReplacement, reconcileSkuReplacement, simulateSkuReplacement } from '../src/shopify-sku-execution.js';
import type { SimulatedSkuWriter } from '../src/shopify-sku-write-adapter.js';
import { WorkerError } from '../src/model.js';
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

async function executionFixture(t: TestContext, path = ':memory:') {
  const store = new Store(path);
  t.after(() => store.close());
  const { id, correlationId, snapshot } = await seed(store);
  const evidence = liveEvidence(snapshot);
  const clock = () => initialTime + 10;
  const dryRun = await dryRunSkuReplacement(store, id, evidence, clock);
  const { plan } = dryRun;
  const approve = () => approveSkuReplacement(store, id, plan.id, 'Fixture owner', 'Fixture SKU execution review', evidence, clock);
  const requests: Parameters<SimulatedSkuWriter['updateSkus']>[0][] = [];
  const apply = (request: Parameters<SimulatedSkuWriter['updateSkus']>[0], count = request.variables.variants.length) => {
    const variants = request.variables.variants.slice(0, count).map(({ id, inventoryItem }) => {
      const variant = snapshot.variants.find(variant => variant.id === id)!;
      variant.sku = inventoryItem.sku;
      return { id, sku: variant.sku };
    });
    snapshot.updatedAt = new Date(initialTime + 100).toISOString();
    return variants;
  };
  const writer: SimulatedSkuWriter = {
    async verifyShop() { return { ...shop, scopes: ['write_products'] }; },
    hextomPaused: () => true,
    async updateSkus(request) {
      requests.push(request);
      return { httpStatus: 200, requestId: 'fixture-request', productId: productGid, variants: apply(request), userErrors: [] };
    },
  };
  return { store, id, correlationId, snapshot, evidence, clock, dryRun, plan, approve, requests, apply, writer };
}

test('Phase 22B dry-run maps all 14 variants and prepares a single SKU-only request', async t => {
  const { store, dryRun, plan, evidence, id, requests } = await executionFixture(t);
  assert.deepEqual(plan.variants.map(row => row.currentSku), initialSkus);
  assert.equal(dryRun.variantCount, 14);
  assert.equal(dryRun.executionAuthorized, false);
  assert.equal(dryRun.liveWritesEnabled, false);
  assert.deepEqual(dryRun.request.variables, {
    productId: productGid,
    variants: plan.variants.map(row => ({ id: row.variantId, inventoryItem: { sku: assignment.productSku } })),
  });
  assert.match(dryRun.request.query, /allowPartialUpdates: false/);
  const later = await dryRunSkuReplacement(store, id, evidence, () => Date.parse('2026-11-27T22:20:00Z'));
  assert.equal(later.status, 'DEFERRED_PROTECTED_WINDOW');
  assert.equal(later.plan.id, plan.id);
  assert.equal(requests.length, 0);
  assert.throws(() => store.shopifySkuJournal.getPlan(plan.id), { code: 'SKU_EXECUTION_APPROVAL_REQUIRED' });
});

test('one separately approved simulation updates 14 SKUs and journals the response and Shopify readback', async t => {
  const { store, plan, approve, evidence, writer, requests, clock, id, correlationId, snapshot } = await executionFixture(t);
  const history = () => [store.inspectProductBinding(id), store.inspectMockupifyJournal(correlationId)];
  const before = history();
  const beforeProduct = structuredClone(snapshot);
  await assert.rejects(simulateSkuReplacement(store, plan.id, 1, evidence, writer, clock), { code: 'SKU_EXECUTION_APPROVAL_REQUIRED' });
  const { approvalSequence } = await approve();
  const result = await simulateSkuReplacement(store, plan.id, approvalSequence, evidence, writer, clock);
  assert.equal(result.status, 'VERIFIED_COMPLETE');
  assert.equal(requests.length, 1);
  assert.equal(result.variants.length, 14);
  assert.ok(result.variants.every(row => row.status === 'AT_TARGET' && row.observedSku === assignment.productSku));
  assert.deepEqual(history(), before);
  assert.deepEqual(snapshot, { ...beforeProduct, updatedAt: snapshot.updatedAt,
    variants: beforeProduct.variants.map(variant => ({ ...variant, sku: assignment.productSku })) });
  const journal = store.shopifySkuJournal.inspect(plan.id);
  assert.deepEqual(journal.plan, plan);
  assert.deepEqual(journal.events.map(event => event.event), ['approved', 'claimed', 'shopify_response', 'readback']);
  assert.ok(journal.events.some(event => event.event === 'shopify_response' && event.response.requestId === 'fixture-request'));
  await assert.rejects(simulateSkuReplacement(store, plan.id, approvalSequence, evidence, writer, clock), { code: 'SKU_EXECUTION_ALREADY_CLAIMED' });
  assert.equal(requests.length, 1);
});

test('a changed SKU, variant set, Shopify product, binding or source invalidates an approved plan', async t => {
  const { store, plan, approve, evidence, writer, requests, clock, snapshot, correlationId, id } = await executionFixture(t);
  const { approvalSequence } = await approve();
  const simulate = (current = evidence) => simulateSkuReplacement(store, plan.id, approvalSequence, current, writer, clock);
  const changedProduct = (edit: (product: ProductRead) => void) => {
    const product = structuredClone(snapshot);
    edit(product);
    return liveEvidence(product);
  };
  await assert.rejects(simulate(changedProduct(product => { product.variants[0]!.sku = 'unexpected'; })),
    { code: 'SKU_REPLACEMENT_UNEXPECTED_SKU' });
  await assert.rejects(simulate(changedProduct(product => { product.variants.pop(); })), { code: 'SKU_REPLACEMENT_VARIANTS' });
  await assert.rejects(simulate(changedProduct(product => { product.variants[0]!.id = product.variants[1]!.id; })),
    { code: 'SKU_REPLACEMENT_VARIANTS' });
  await assert.rejects(simulate(changedProduct(product => { product.title = 'Changed'; })), { code: 'SKU_REPLACEMENT_BINDING_DRIFT' });
  await assert.rejects(simulate(changedProduct(product => { product.variants[0]!.sku = `${assignment.productSku}-Black-X-Small`; })),
    { code: 'SKU_REPLACEMENT_STAGE_CHANGED' });
  await assert.rejects(simulate({ ...evidence, async readMasterInput() { return [{ ...sourceRow, rowNumber: 10 }]; } }),
    { code: 'SKU_REPLACEMENT_SOURCE_CHANGED' });
  await assert.rejects(simulate({ ...evidence, async readMasterInput() {
    return [sourceRow, { ...sourceRow, rowNumber: 10, productSku: 'different-garment' }];
  } }), { code: 'SKU_EXECUTION_PLAN_CHANGED' });
  const provenance = store.getMockupifyJournal(correlationId);
  store.updateMockupifyJournal(provenance, { event: 'fixture' });
  await assert.rejects(simulate(), { code: 'SKU_EXECUTION_PLAN_CHANGED' });
  store.recordProductBindingReview(id, { event: 'stale', review: 'recheck', by: 'Fixture owner', at: initialTime, code: 'FIXTURE_DRIFT' });
  await assert.rejects(simulate(), { code: 'SKU_REPLACEMENT_APPROVAL_REQUIRED' });
  assert.equal(requests.length, 0);
});

test('approval requires the exact plan ID and the latest unexpired approval sequence', async t => {
  const { store, id, plan, approve, evidence, writer, requests, clock } = await executionFixture(t);
  await assert.rejects(approveSkuReplacement(store, id, 'different-plan', 'Fixture owner', 'Fixture review', evidence, clock),
    { code: 'SKU_EXECUTION_PLAN_CHANGED' });
  const first = await approve();
  const second = await approve();
  await assert.rejects(simulateSkuReplacement(store, plan.id, first.approvalSequence, evidence, writer, clock),
    { code: 'SKU_EXECUTION_APPROVAL_CHANGED' });
  await assert.rejects(simulateSkuReplacement(store, plan.id, second.approvalSequence, evidence, writer, () => second.expiresAt),
    { code: 'SKU_EXECUTION_APPROVAL_CHANGED' });
  let replaced = false;
  await assert.rejects(simulateSkuReplacement(store, plan.id, second.approvalSequence, {
    ...evidence, async readMasterInput() {
      if (!replaced) {
        replaced = true;
        await approve();
      }
      return [sourceRow];
    },
  }, writer, clock), { code: 'SKU_EXECUTION_APPROVAL_CHANGED' });
  assert.equal(requests.length, 0);
});

test('execution checks Shopify scope, Hextom pause, and both ends of the protected window', async t => {
  const { store, plan, evidence, writer, requests, id } = await executionFixture(t);
  const cutoff = Date.parse('2026-11-27T22:20:00Z');
  const end = Date.parse('2026-11-28T03:10:00Z');
  let now = cutoff - 500;
  const executionClock = () => now;
  const approval = await approveSkuReplacement(store, id, plan.id, 'Fixture owner', 'Fixture review', evidence, executionClock);
  const simulate = (adapter = writer, time = executionClock) =>
    simulateSkuReplacement(store, plan.id, approval.approvalSequence, evidence, adapter, time);
  await assert.rejects(simulate({ ...writer, async verifyShop() { return { ...shop, scopes: ['read_products'] }; } }),
    { code: 'SKU_EXECUTION_WRITE_SCOPE_REQUIRED' });
  await assert.rejects(simulate({ ...writer, hextomPaused: () => false }), { code: 'SKU_EXECUTION_HEXTOM_HOLD' });
  now = cutoff;
  await assert.rejects(simulate(), { code: 'HEXTOM_WINDOW' });
  now = cutoff - 1;
  let pauses = 0;
  await assert.rejects(simulate({ ...writer, hextomPaused() {
    if (++pauses === 2) now = cutoff;
    return true;
  } }), { code: 'HEXTOM_WINDOW' });
  assert.ok(store.shopifySkuJournal.inspect(plan.id).events.some(event => event.event === 'cancelled_before_send'));
  assert.equal(requests.length, 0);
  now = end - 1;
  const evening = await approveSkuReplacement(store, id, plan.id, 'Fixture owner', 'Fixture evening review', evidence, executionClock);
  await assert.rejects(simulateSkuReplacement(store, plan.id, evening.approvalSequence, evidence, writer, executionClock), { code: 'HEXTOM_WINDOW' });
  now = end;
  assert.equal((await simulateSkuReplacement(store, plan.id, evening.approvalSequence, evidence, writer, executionClock)).status, 'VERIFIED_COMPLETE');
  assert.equal(requests.length, 1);
});

test('journal records Shopify indexed validation errors and observes all original SKUs', async t => {
  const { store, plan, approve, evidence, writer, clock } = await executionFixture(t);
  const { approvalSequence } = await approve();
  const userErrors = [{ code: 'INVALID_INPUT', field: ['variants', '1', 'inventoryItem', 'sku'], message: 'Fixture SKU rejected' }];
  const result = await simulateSkuReplacement(store, plan.id, approvalSequence, evidence, {
    ...writer, async updateSkus() { return { productId: null, variants: null, userErrors }; },
  }, clock);
  assert.equal(result.status, 'VERIFIED_REJECTED');
  assert.ok(result.variants.every(variant => variant.status === 'AT_ORIGINAL'));
  assert.ok(store.shopifySkuJournal.inspect(plan.id).events.some(event => event.event === 'shopify_response'
    && event.response.userErrors?.[0]?.field?.[1] === '1'));
});

test('partial results are held and read-only recovery preserves transformed SKUs', async t => {
  const { store, plan, approve, evidence, writer, clock, snapshot, apply, requests } = await executionFixture(t);
  const { approvalSequence } = await approve();
  const sim = simulateSkuReplacement(store, plan.id, approvalSequence, evidence, {
    ...writer, async updateSkus(request) {
      requests.push(request);
      return { productId: productGid, variants: apply(request, 3), userErrors: [] };
    },
  }, clock);
  const result = await sim;
  assert.equal(result.status, 'HELD_PARTIAL_UPDATE');
  assert.equal(result.variants.filter(variant => variant.status === 'AT_TARGET').length, 3);
  assert.equal(result.variants.filter(variant => variant.status === 'AT_ORIGINAL').length, 11);
  snapshot.variants[0]!.sku = `${assignment.productSku}-Black-X-Small`;
  const recovery = await reconcileSkuReplacement(store, plan.id, evidence, clock);
  assert.equal(recovery.status, 'HELD_POSSIBLE_HEXTOM_OR_UNEXPECTED_SKU');
  assert.equal(recovery.variants[0]!.observedSku, snapshot.variants[0]!.sku);
  await assert.rejects(simulateSkuReplacement(store, plan.id, approvalSequence, evidence, writer, clock), { code: 'SKU_EXECUTION_ALREADY_CLAIMED' });
  assert.equal(requests.length, 1);
});

test('network failures never resend and fresh readback can recover a lost successful response', async t => {
  const { store, plan, approve, evidence, writer, clock, apply, requests } = await executionFixture(t);
  const { approvalSequence } = await approve();
  let offline = false;
  const networkEvidence = { ...evidence, shopify: { async product() {
    if (offline) throw new WorkerError('SHOPIFY_TRANSIENT', 'Fixture connection failure');
    return evidence.shopify.product();
  } } };
  await assert.rejects(simulateSkuReplacement(store, plan.id, approvalSequence, networkEvidence, {
    ...writer, async updateSkus(request) {
      requests.push(request);
      apply(request);
      offline = true;
      throw new Error('Fixture lost response');
    },
  }, clock), { code: 'SHOPIFY_TRANSIENT' });
  assert.deepEqual(store.shopifySkuJournal.inspect(plan.id).events.slice(-2).map(event => event.event), ['dispatch_error', 'readback_error']);
  offline = false;
  const result = await reconcileSkuReplacement(store, plan.id, networkEvidence, clock);
  assert.equal(result.status, 'VERIFIED_TARGETS_DISPATCH_UNCONFIRMED');
  await assert.rejects(simulateSkuReplacement(store, plan.id, approvalSequence, networkEvidence, writer, clock),
    { code: 'SKU_EXECUTION_ALREADY_CLAIMED' });
  assert.equal(requests.length, 1);
});

test('a persisted claim holds an interrupted execution even when all variants still have original SKUs', async t => {
  const path = databasePath(t);
  const { store, plan, approve, evidence, writer, clock, requests } = await executionFixture(t, path);
  const { approvalSequence } = await approve();
  store.shopifySkuJournal.claim(plan, approvalSequence, clock(), () => {});
  const restarted = new Store(path, { existing: true });
  t.after(() => restarted.close());
  assert.equal((await reconcileSkuReplacement(restarted, plan.id, evidence, clock)).status, 'HELD_DISPATCH_UNCONFIRMED');
  await assert.rejects(simulateSkuReplacement(restarted, plan.id, approvalSequence, evidence, writer, clock),
    { code: 'SKU_EXECUTION_ALREADY_CLAIMED' });
  assert.equal(requests.length, 0);
});

test('concurrent executors that cleared preflight can dispatch only once across SQLite connections', async t => {
  const path = databasePath(t);
  const { store, plan, approve, evidence, writer, clock, requests } = await executionFixture(t, path);
  const other = new Store(path, { existing: true });
  t.after(() => other.close());
  const { approvalSequence } = await approve();
  const firstRead = Promise.withResolvers<void>();
  const resumeRead = Promise.withResolvers<void>();
  const secondClaim = Promise.withResolvers<void>();
  const resumeWrite = Promise.withResolvers<void>();
  let reads = 0;
  const first = simulateSkuReplacement(store, plan.id, approvalSequence, {
    ...evidence, shopify: { async product() {
      if (++reads === 2) {
        firstRead.resolve();
        await resumeRead.promise;
      }
      return evidence.shopify.product();
    } },
  }, writer, clock);
  await firstRead.promise;
  const second = simulateSkuReplacement(other, plan.id, approvalSequence, evidence, {
    ...writer, async updateSkus(request) {
      secondClaim.resolve();
      await resumeWrite.promise;
      return writer.updateSkus(request);
    },
  }, clock);
  await secondClaim.promise;
  try {
    resumeRead.resolve();
    await assert.rejects(first, { code: 'SKU_EXECUTION_ALREADY_CLAIMED' });
  } finally {
    resumeWrite.resolve();
    await second;
  }
  assert.equal(requests.length, 1);
});

test('first SKU approval adds an immutable journal and preserves an existing registry and its durability history', async t => {
  const path = databasePath(t);
  const { store, plan, approve, id, correlationId } = await executionFixture(t, path);
  const before = [store.inspectProductBinding(id), store.inspectMockupifyJournal(correlationId)];
  assert.ok((await store.verifyMockupifyDurability(dirname(path))).admitted);
  await approve();
  assert.equal(store.mockupifyDurabilityStatus().admitted, false);
  assert.deepEqual([store.inspectProductBinding(id), store.inspectMockupifyJournal(correlationId)], before);
  using db = new DatabaseSync(path);
  assert.throws(() => db.prepare('UPDATE shopify_sku_plans SET body = ? WHERE id = ?').run('{}', plan.id), /append-only/);
  assert.throws(() => db.prepare('UPDATE shopify_sku_approvals SET body = ? WHERE plan_id = ?').run('{}', plan.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM shopify_sku_events WHERE plan_id = ?').run(plan.id), /append-only/);
  assert.ok((await store.verifyMockupifyDurability(dirname(path))).admitted);
});

test('Phase 22B commands expose no execution switch and dry-run cannot create a database', t => {
  const path = databasePath(t);
  const run = (...args: string[]) => spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', 'dist/src/cli.js', ...args,
  ], { encoding: 'utf8', env: { ...process.env, TEES4_DATABASE: path } });
  assert.match(run('mockupify-sku-replacement-execute', 'fixture-binding').stderr, /CLI_USAGE/);
  assert.match(run('mockupify-sku-replacement-dry-run', 'fixture-binding', '--execute').stderr, /CLI_USAGE/);
  assert.match(run('mockupify-sku-replacement-dry-run', 'fixture-binding').stderr, /DATABASE_OPEN/);
  assert.match(run('mockupify-sku-replacement-approve', 'fixture-binding', 'fixture-plan', '--by', 'owner', '--source', 'review').stderr, /DATABASE_OPEN/);
  assert.equal(existsSync(path), false);
  const store = new Store(path);
  store.close();
  const inspect = run('mockupify-sku-replacement-inspect', 'fixture-plan');
  assert.match(inspect.stderr, /SKU_EXECUTION_APPROVAL_REQUIRED/);
});
