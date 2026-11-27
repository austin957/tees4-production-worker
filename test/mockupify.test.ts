import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { readJson } from '../src/config.js';
import { runMockupifyExport } from '../src/export-runner.js';
import { planMockupifyExport, simulatedMockupifyExports } from '../src/mockupify.js';
import type { ExportPlan } from '../src/mockupify.js';
import { readProductionArtwork, simulatedSheets } from '../src/sheets.js';
import { Store } from '../src/store.js';

const sheet = readJson('examples/sheet-input.json', 'sheet fixture') as { artwork: unknown; rows: unknown[] };
const mapping = readJson('examples/mockupify-mapping.json', 'mapping');
const morning = Date.parse('2026-07-11T15:00:00Z');

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tees4-export-'));
  const path = join(directory, 'queue.sqlite');
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const artwork = await readProductionArtwork(sheet.artwork, simulatedSheets(sheet.rows));
  const plan = planMockupifyExport(artwork, mapping);
  return { artwork, plan, store, path };
}

function evidence(plan: ExportPlan, id: string) {
  return {
    correlationId: id,
    exportRef: `trace-${id}`,
    products: plan.products.map(row => ({
      id: `gid://shopify/Product/${row.sourceRow}`,
      sourceRow: row.sourceRow,
      artworkSku: plan.artworkSku,
      productSku: row.productSku,
      variants: row.colors.map((color, index) => ({
        id: `gid://shopify/ProductVariant/${row.sourceRow * 100 + index}`,
        size: 'M',
        color: color.label,
      })),
    })),
  };
}

test('plans multiple garment templates, exact SKUs, per-garment metadata and colors', async t => {
  const { plan } = await setup(t);
  assert.equal(plan.artworkSku, '00042');
  assert.equal(plan.designTitle, 'Example Artwork');
  assert.equal(plan.artworkRef, 'fixture://drive/example-artwork-002.svg');
  assert.equal(plan.batchId, 'fixture-batch-1');
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.products.map(row => [row.sourceRow, row.productSku, row.templateId, row.colors.map(color => color.mockupifyColorId)]), [
    [2, '000710', 'fixture-adult-tee', ['fixture-tee-white', 'fixture-tee-black']],
    [3, '000711', 'fixture-hoodie', ['fixture-hoodie-navy']],
  ]);
  assert.deepEqual(plan.products.map(row => [row.title, row.description, row.vendor, row.tags]), [
    ['Example Tee', 'Printed tee', 'Example Vendor', 'example'],
    ['Example Hoodie', 'Printed hoodie', 'Example Vendor', 'example'],
  ]);
});

test('unmapped templates and colors require review and dry-run never calls the adapter', async t => {
  const { store, artwork, plan } = await setup(t);
  const bad = planMockupifyExport(artwork, {
    batchId: 'batch', templates: { Tee: { templateId: 'tee', colors: { White: 'white' } } },
  });
  assert.deepEqual(bad.issues.map(issue => [issue.sourceRow, issue.code, issue.value]), [
    [2, 'UNMAPPED_COLOR', 'Black'], [3, 'UNMAPPED_TEMPLATE', 'Hoodie'], [3, 'UNMAPPED_COLOR', 'Navy'],
  ]);
  const adapter = { export: async () => assert.fail('Should not dispatch') };
  const review = store.queueExport(bad, 'simulate', morning);
  assert.equal((await runMockupifyExport(store, review.id, adapter, () => morning, 1)).status, 'needs_review');
  const dry = store.queueExport(plan, 'dry-run', morning);
  assert.equal((await runMockupifyExport(store, dry.id, adapter, () => morning, 1)).status, 'planned');
  assert.equal(store.queueExport(plan, 'simulate', morning).id, review.id);
  assert.deepEqual(await store.shopifySkuAdapter().findProducts('000710'), []);
});

test('deduplicates submissions, dispatch claims and product reservations across processes', async t => {
  const { store, path, plan } = await setup(t);
  const job = store.queueExport(plan, 'simulate', morning);
  assert.equal(store.queueExport(plan, 'simulate', morning).id, job.id);
  assert.throws(() => store.queueExport({ ...plan, batchId: 'different' }, 'simulate', morning), { code: 'EXPORT_PLAN_CONFLICT' });
  assert.throws(() => store.queueExport({ ...plan, artworkSku: 'OTHER' }, 'simulate', morning), { code: 'EXPORT_PRODUCT_CONFLICT' });

  const second = new Store(path);
  try {
    let starts = 0;
    const adapter = {
      async export(...args: Parameters<ReturnType<typeof simulatedMockupifyExports>['export']>) {
        const [snapshot, id, begin] = args;
        if (!begin()) return undefined;
        starts += 1;
        await Promise.resolve();
        return evidence(snapshot, id);
      },
    };
    await Promise.all([
      runMockupifyExport(store, job.id, adapter, () => morning, 1),
      runMockupifyExport(second, job.id, adapter, () => morning, 1),
    ]);
    assert.equal(starts, 1);
    const done = second.getExport(job.id);
    assert.equal(done.status, 'completed');
    const [product] = await second.shopifySkuAdapter().findProducts('000710');
    assert.equal(product?.id, 'gid://shopify/Product/2');
    assert.equal(product?.sourceRow, 2);
    assert.equal(product?.mockupifyExportRef, done.evidence?.exportRef);
    assert.deepEqual(product?.variants.map(variant => [variant.id, variant.sku]), [
      ['gid://shopify/ProductVariant/200', null], ['gid://shopify/ProductVariant/201', null],
    ]);
  } finally {
    second.close();
  }
});

test('persists partial results, requires reconciliation and rejects conflicting evidence', async t => {
  const { store, path, plan } = await setup(t);
  const job = store.queueExport(plan, 'simulate', morning);
  const full = evidence(plan, job.id);
  const first = await runMockupifyExport(store, job.id, {
    async export(_, __, begin) {
      assert.ok(begin());
      return { ...full, products: full.products.slice(0, 1) };
    },
  }, () => morning, 1);
  assert.equal(first.status, 'uncertain');
  assert.equal(first.code, 'PARTIAL_EXPORT_EVIDENCE');
  assert.equal(first.evidence?.bindings.length, 1);

  const reopened = new Store(path);
  try {
    const noRetry = { export: async () => assert.fail('An uncertain export was retried') };
    assert.equal((await runMockupifyExport(reopened, job.id, noRetry, () => morning, 1)).status, 'uncertain');
    assert.throws(() => reopened.recordExportEvidence(job.id, { ...full, correlationId: 'different' }), { code: 'EXPORT_BINDING_CONFLICT' });
    assert.throws(() => reopened.recordExportEvidence(job.id, { ...full, products: [
      ...full.products.slice(0, 1), { ...full.products[1], sourceRow: 100 },
    ] }), { code: 'EXPORT_BINDING_CONFLICT' });
    assert.throws(() => reopened.recordExportEvidence(job.id, { ...full, products: [
      { ...full.products[0], id: 'different-id' },
    ] }), { code: 'EXPORT_BINDING_CONFLICT' });
    const done = reopened.recordExportEvidence(job.id, { ...full, products: full.products.slice(1) });
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.evidence?.bindings.map(binding => binding.sourceRow), [2, 3]);
    assert.deepEqual(reopened.recordExportEvidence(job.id, full), done);
  } finally {
    reopened.close();
  }
});

test('lost responses and interrupted dispatches remain durable and cannot trigger another export', async t => {
  const { store, path, plan } = await setup(t);
  const timedOut = store.queueExport(plan, 'simulate', morning);
  const result = await runMockupifyExport(store, timedOut.id, {
    async export(_, __, begin) {
      assert.ok(begin());
      throw new Error('Timed out after dispatch');
    },
  }, () => morning, 1);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.code, 'EXPORT_RESULT_UNKNOWN');

  const next = { ...plan, artworkSku: 'OTHER', products: plan.products.map(row => ({ ...row, productSku: `fixture-${row.productSku}` })) };
  const interrupted = store.queueExport(next, 'simulate', morning);
  assert.ok(store.beginExport(interrupted.id, () => morning, 1));
  const reopened = new Store(path);
  try {
    const adapter = { export: async () => assert.fail('Dispatched export was retried') };
    assert.equal((await runMockupifyExport(reopened, timedOut.id, adapter, () => morning, 1)).status, 'uncertain');
    assert.equal((await runMockupifyExport(reopened, interrupted.id, adapter, () => morning, 1)).status, 'dispatching');
    assert.equal(reopened.recordExportEvidence(interrupted.id, evidence(next, interrupted.id)).status, 'completed');
  } finally {
    reopened.close();
  }
});

test('checks the safety margin and protected window at the dispatch boundary', async t => {
  const { store, plan } = await setup(t);
  const start = Date.parse('2026-07-11T21:20:00Z');
  const end = Date.parse('2026-07-12T02:10:00Z');
  let now = start - 120_000;
  const job = store.queueExport(plan, 'simulate', now);
  const deferred = await runMockupifyExport(store, job.id, {
    async export(_, __, begin) {
      now = start;
      assert.equal(begin(), false);
      return undefined;
    },
  }, () => now, 1);
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.code, 'MOCKUPIFY_WINDOW');
  assert.equal(deferred.availableAt, end);
  now = end - 60_000;
  assert.equal((await runMockupifyExport(store, job.id, simulatedMockupifyExports(), () => now, 1)).status, 'deferred');
  now = end;
  const missing = await runMockupifyExport(store, job.id, simulatedMockupifyExports(), () => now);
  assert.equal(missing.code, 'EXPORT_MARGIN_REQUIRED');
  now = missing.availableAt;
  assert.equal((await runMockupifyExport(store, job.id, simulatedMockupifyExports(), () => now, 1)).status, 'completed');
});

test('CLI exports fixtures and passes captured IDs to the existing garment completion workflow', async t => {
  const { path } = await setup(t);
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--import', `data:text/javascript,Date.now=()=>${morning}`,
      'dist/src/cli.js', ...args,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env, TEES4_DATABASE: path, TEES4_CONFIG: 'examples/completion-workflow.json',
        TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const input = ['examples/sheet-input.json', 'examples/mockupify-mapping.json'];
  const planned = run('queue-export', ...input);
  assert.equal(run('run-export', planned.id).status, 'planned');

  const queued = run('queue-export', ...input, '--mode', 'simulate');
  assert.equal(run('run-export', queued.id).status, 'completed');
  const captured = run('inspect-export', queued.id);
  assert.equal(captured.evidence.bindings.length, 2);
  run('load-sheet-fixture', input[0]!);
  const submitted = run('submit-sheet', input[0]!, '--mode', 'simulate');
  run('run');
  const completed = run('inspect', submitted.jobId);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(
    completed.garmentCompletions.map((row: { productId: string }) => row.productId),
    captured.evidence.bindings.map((row: { product: { id: string } }) => row.product.id),
  );
});
