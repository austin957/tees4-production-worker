import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { simulatedAdapters } from '../src/adapters.js';
import { readJson } from '../src/config.js';
import { WorkerError } from '../src/model.js';
import { masterInput, readProductionArtwork, simulatedSheets } from '../src/sheets.js';
import { parseShopifyCatalog, protectedUntil } from '../src/shopify-skus.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';

const fixture = readJson('examples/sheet-input.json', 'sheet fixture') as {
  artwork: Record<string, string>;
  rows: { rowNumber: number; cells: unknown[] }[];
};
const catalog = parseShopifyCatalog(readJson('examples/shopify-products.json', 'Shopify fixture'));
const workflow = readJson('examples/sku-workflow.json', 'workflow') as Record<string, unknown>;
const instant = Date.parse('2026-07-10T20:00:00Z');

async function setup(t: TestContext, products = catalog) {
  const directory = mkdtempSync(join(tmpdir(), 'tees4-skus-'));
  const path = join(directory, 'queue.sqlite');
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  });
  store.importShopifyFixtures(products);
  const artwork = await readProductionArtwork(fixture.artwork, simulatedSheets(fixture.rows));
  return { store, path, artwork, adapter: store.shopifySkuAdapter() };
}

test('reads the specified Master Input and groups garments without normalizing identifiers', async () => {
  const artwork = await readProductionArtwork(fixture.artwork, {
    readRows: async source => {
      assert.deepEqual(source, masterInput);
      return [...fixture.rows].reverse();
    },
  });
  assert.equal(artwork.artworkSku, '00042');
  assert.equal(artwork.designerId, fixture.artwork.designerId);
  assert.deepEqual(artwork.garments.map(garment => [garment.sourceRow, garment.productSku, garment.garmentSelection]), [
    [2, '000710', 'Tee'], [3, '000711', 'Hoodie'],
  ]);
  assert.equal(artwork.garments[0]?.colors, 'White, Black');
  assert.equal(artwork.garments[0]?.vendor, 'Example Vendor');
  assert.equal(artwork.garments[1]?.productDescription, 'Printed hoodie');
  assert.equal(artwork.garments[1]?.tags, 'example');
});

test('rejects invalid positional rows and duplicate product assignments across Artwork SKUs', async () => {
  const [first, second] = fixture.rows;
  const validate = (rows: unknown[]) => readProductionArtwork(fixture.artwork, simulatedSheets(rows));
  assert.ok(first && second);
  await assert.rejects(validate([{ ...first, cells: first.cells.slice(0, 8) }]), { code: 'INVALID_SHEET_ROW' });
  for (const [index, value] of [[7, 710], [7, ' 000710'], [10, ''], [4, null]] as const) {
    const cells = [...first.cells];
    cells[index] = value;
    await assert.rejects(validate([{ ...first, cells }]), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(validate([first, first]), { code: 'DUPLICATE_SHEET_ROW' });
  const conflictingSku = [...first.cells];
  conflictingSku[10] = 'OTHER-ARTWORK';
  await assert.rejects(validate([first, { ...second, cells: conflictingSku }]), { code: 'DUPLICATE_PRODUCT_SKU' });
  const conflictingName = [...second.cells];
  conflictingName[0] = 'Other name';
  await assert.rejects(validate([first, { ...second, cells: conflictingName }]), { code: 'ARTWORK_NAME_CONFLICT' });
  await assert.rejects(readProductionArtwork({ ...fixture.artwork, artworkSku: 'absent' }, simulatedSheets([first])), {
    code: 'ARTWORK_NOT_FOUND',
  });
});

test('simulated import and sheet submission persist across CLI invocations, with dry-run as default', async t => {
  const { path, adapter } = await setup(t);
  const exec = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/src/cli.js', ...args], {
      encoding: 'utf8', env: { ...process.env, TEES4_DATABASE: path, TEES4_CONFIG: 'examples/sku-workflow.json' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(exec('load-shopify-fixture', 'examples/shopify-products.json'), { imported: 0 });
  const submitted = exec('submit-sheet', 'examples/sheet-input.json');
  assert.equal(submitted.mode, 'dry-run');
  exec('run');
  const report = exec('inspect', submitted.jobId);
  assert.equal(report.status, 'needs_review');
  assert.deepEqual(report.stages[1].skuAssignments[2].review, {
    code: 'UNEXPECTED_VARIANT_SKU', observedSku: 'existing-sku-preserve-exactly',
  });
  assert.deepEqual(report.stages[1].skuAssignments.map((entry: { outcome: string }) => entry.outcome), [
    'planned', 'planned', 'preserved', 'planned', 'already_assigned',
  ]);
  assert.deepEqual((await adapter.findProducts('000710'))[0]?.variants.map(variant => variant.sku), [
    null, null, 'existing-sku-preserve-exactly',
  ]);
});

test('assigns the same Product SKU to each blank variant, preserves existing SKUs, and deduplicates jobs', async t => {
  const { store, artwork, adapter } = await setup(t);
  const worker = new Worker(store, simulatedAdapters(store), undefined, () => instant);
  const { job } = worker.submit(artwork, workflow, 'simulate');
  assert.equal(worker.submit(artwork, workflow, 'simulate').job.id, job.id);
  assert.throws(() => worker.submit({ ...artwork, artworkId: 'duplicate-artwork' }, workflow, 'simulate'), {
    code: 'JOB_CONFLICT',
  });
  const legacy = readJson('examples/workflow.json', 'workflow');
  assert.throws(() => worker.submit(artwork, legacy), { code: 'WORKFLOW_INPUT_MISMATCH' });
  await worker.runAvailable();
  const result = store.get(job.id);
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.results[1]?.skuAssignments?.map(entry => [entry.productId, entry.outcome]), [
    ['fixture-product-101', 'assigned'], ['fixture-product-101', 'assigned'], ['fixture-product-101', 'preserved'],
    ['fixture-product-102', 'assigned'], ['fixture-product-102', 'already_assigned'],
  ]);
  assert.deepEqual((await adapter.findProducts('000710'))[0]?.variants.map(variant => variant.sku), [
    '000710', '000710', 'existing-sku-preserve-exactly',
  ]);
  assert.deepEqual((await adapter.findProducts('000711'))[0]?.variants.map(variant => variant.sku), ['000711', '000711']);
  assert.equal(store.importShopifyFixtures(catalog), 0);
  assert.equal((await adapter.findProducts('000710'))[0]?.variants[0]?.sku, '000710');
  assert.deepEqual(await worker.runAvailable(), { processed: 0, failed: [] });
});

test('stops on ambiguous, missing or conflicting bindings before writing to any garment', async t => {
  const first = catalog[0]!;
  const second = catalog[1]!;
  const cases = [
    { products: [first, second, { ...second, id: 'ambiguous', variants: [{ ...second.variants[0]!, id: 'another-variant' }] }],
      code: 'AMBIGUOUS_PRODUCT' },
    { products: [first], code: 'PRODUCT_NOT_FOUND' },
    { products: [first, { ...second, artworkSku: 'OTHER' }], code: 'PRODUCT_BINDING_CONFLICT' },
  ];
  for (const { products, code } of cases) {
    const { store, artwork, adapter } = await setup(t, products);
    const worker = new Worker(store, simulatedAdapters(store), undefined, () => instant);
    const { job } = worker.submit(artwork, workflow, 'simulate');
    assert.deepEqual(await worker.runAvailable(), { processed: 2, failed: [job.id] });
    assert.equal(store.get(job.id).history.at(-1)?.code, code);
    assert.equal((await adapter.findProducts(first.productSku))[0]?.variants[0]?.sku, null);
  }
});

test('recovers a partial write and preserves a final SKU written between attempts', async t => {
  const products = catalog.map((product, index) => ({ ...product, mockupifyExportRef: `partial-export-${index}` }));
  const { store, path, artwork, adapter } = await setup(t, products);
  let now = instant;
  const failing = {
    ...adapter,
    assignInitialSku: async (...args: Parameters<typeof adapter.assignInitialSku>) => {
      const outcome = await adapter.assignInitialSku(...args);
      if (outcome.outcome === 'assigned') throw new WorkerError('SIMULATED_TIMEOUT', 'Timed out after writing a variant.', true);
      return outcome;
    },
  };
  const worker = new Worker(store, simulatedAdapters(store), undefined, () => now, failing);
  const { job } = worker.submit(artwork, workflow, 'simulate');
  await worker.runAvailable();
  assert.equal(store.get(job.id).status, 'retry_wait');
  assert.deepEqual((await adapter.findProducts('000710'))[0]?.variants.slice(0, 2).map(variant => variant.sku), ['000710', null]);
  const external = new DatabaseSync(path);
  try {
    external.prepare('UPDATE shopify_variants SET sku = ? WHERE id = ?').run('final-value-from-hextom', 'fixture-variant-201');
  } finally {
    external.close();
  }
  now += 1000;
  const reopened = new Store(path);
  try {
    const resumed = new Worker(reopened, simulatedAdapters(reopened), undefined, () => now);
    await resumed.runAvailable();
    const result = reopened.get(job.id);
    assert.equal(result.status, 'needs_review');
    assert.equal(result.results[1]?.skuAssignments?.[0]?.outcome, 'preserved');
    assert.deepEqual(result.results[1]?.skuAssignments?.[0]?.review, {
      code: 'UNEXPECTED_VARIANT_SKU', observedSku: 'final-value-from-hextom',
    });
    assert.equal(result.results[1]?.skuAssignments?.[1]?.outcome, 'assigned');
    const [binding] = await reopened.shopifySkuAdapter().findProducts('000710');
    assert.equal(result.results[1]?.skuAssignments?.[1]?.productId, binding?.id);
    assert.equal(result.results[1]?.skuAssignments?.[1]?.variantId, binding?.variants[1]?.id);
    assert.equal(binding?.mockupifyExportRef, 'partial-export-0');
    assert.equal((await adapter.findProducts('000710'))[0]?.variants[0]?.sku, 'final-value-from-hextom');
  } finally {
    reopened.close();
  }
});

test('Chicago protection uses inclusive 5 PM and exclusive 9 PM across CST and CDT', () => {
  for (const [start, end] of [
    ['2026-01-11T23:00:00Z', '2026-01-12T03:00:00Z'],
    ['2026-07-11T22:00:00Z', '2026-07-12T02:00:00Z'],
    ['2026-03-08T22:00:00Z', '2026-03-09T02:00:00Z'],
    ['2026-11-01T23:00:00Z', '2026-11-02T03:00:00Z'],
  ]) {
    const from = Date.parse(start!);
    const until = Date.parse(end!);
    assert.equal(protectedUntil(from - 1), undefined);
    assert.equal(protectedUntil(from), until);
    assert.equal(protectedUntil(until - 1), until);
    assert.equal(protectedUntil(until), undefined);
  }
});

test('rechecks protection at the write and reschedules without consuming a retry', async t => {
  const { store, artwork, adapter } = await setup(t);
  const startsAt = Date.parse('2026-07-11T22:00:00Z');
  const endsAt = Date.parse('2026-07-12T02:00:00Z');
  let now = startsAt - 1;
  let calls = 0;
  const delayed = {
    ...adapter,
    assignInitialSku: async (...args: Parameters<typeof adapter.assignInitialSku>) => {
      if (++calls === 1) now = startsAt;
      return adapter.assignInitialSku(...args);
    },
  };
  const worker = new Worker(store, simulatedAdapters(store), undefined, () => now, delayed);
  const { job } = worker.submit(artwork, { ...workflow, maxAttempts: 1 }, 'simulate');
  await worker.runAvailable();
  const wait = store.get(job.id);
  assert.equal(wait.status, 'retry_wait');
  assert.equal(wait.failures, 0);
  assert.equal(wait.availableAt, endsAt);
  assert.equal(wait.history.at(-1)?.code, 'HEXTOM_WINDOW');
  assert.equal((await adapter.findProducts('000710'))[0]?.variants[0]?.sku, null);
  now = endsAt - 1;
  assert.deepEqual(await worker.runAvailable(), { processed: 0, failed: [] });
  now = endsAt;
  await worker.runAvailable();
  assert.equal(store.get(job.id).status, 'needs_review');
  assert.equal((await adapter.findProducts('000710'))[0]?.variants[0]?.sku, '000710');
});

test('preserves immutable export provenance and existing IDs during dry-run', async t => {
  const products = catalog.map((product, index) => ({ ...product, mockupifyExportRef: `fixture-export-${index}` }));
  const { store, path, adapter, artwork } = await setup(t, products);
  assert.throws(() => store.importShopifyFixtures([{ ...products[0]!, mockupifyExportRef: 'changed-export' }]), {
    code: 'FIXTURE_CONFLICT',
  });
  const second = new Store(path);
  try {
    assert.deepEqual(await second.shopifySkuAdapter().findProducts('000710'), [products[0]]);
    const noWrites = {
      ...adapter,
      assignInitialSku: async () => assert.fail('Dry-run attempted a variant write'),
    };
    const worker = new Worker(second, simulatedAdapters(second), undefined, () => instant, noWrites);
    const { job } = worker.submit(artwork, workflow);
    await worker.runAvailable();
    const record = second.get(job.id);
    assert.equal(record.results[1]?.skuAssignments?.[0]?.productId, 'fixture-product-101');
    assert.equal(record.results[1]?.skuAssignments?.[0]?.variantId, 'fixture-variant-201');
    assert.deepEqual(await second.shopifySkuAdapter().findProducts('000710'), [products[0]]);
  } finally {
    second.close();
  }
});
