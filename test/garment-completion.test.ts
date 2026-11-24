import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { simulatedAdapters } from '../src/adapters.js';
import { readJson } from '../src/config.js';
import { WorkerError } from '../src/model.js';
import { readProductionArtwork, simulatedSheets } from '../src/sheets.js';
import { parseShopifyCatalog } from '../src/shopify-skus.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';

const workflow = readJson('examples/completion-workflow.json', 'workflow');
const sheet = readJson('examples/sheet-input.json', 'sheet fixture') as {
  artwork: Record<string, string>;
  rows: { rowNumber: number; cells: unknown[] }[];
};
const morning = Date.parse('2026-07-11T15:00:00Z');
const open = Date.parse('2026-07-12T02:10:00Z');
const closed = Date.parse('2026-07-11T21:20:00Z');

async function fixture(t: TestContext, init?: (rows: typeof sheet.rows, products: ReturnType<typeof parseShopifyCatalog>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'tees4-complete-'));
  const path = join(dir, 'queue.sqlite');
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const catalog = parseShopifyCatalog(readJson('examples/shopify-products.json', 'Shopify fixture'));
  catalog[0]!.variants[2]!.sku = '000710';
  const rows = structuredClone(sheet.rows);
  for (const row of rows) row.cells.push('TeeInBlue state', 'Flash Transfers state');
  const artwork = await readProductionArtwork(sheet.artwork, simulatedSheets(rows));
  init?.(rows, catalog);
  store.importSheetFixtures(rows);
  store.importShopifyFixtures(catalog);

  const cells = (rowNumber: number): unknown[] => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return JSON.parse(db.prepare('SELECT cells FROM master_input_fixtures WHERE row_number = ?').get(rowNumber)?.cells as string) as unknown[];
    } finally {
      db.close();
    }
  };
  return { dir, path, store, rows, catalog, artwork, cells, shopify: store.shopifySkuAdapter(), sheets: store.sheetsCompletionAdapter() };
}

test('completes each matching row after assigning partially completed variants and ignores duplicate submissions', async t => {
  const { store, artwork, shopify, cells, rows, catalog } = await fixture(t, (rows, products) => {
    rows[1]!.cells[8] = '';
    products[0]!.variants[0]!.sku = '000710';
    const unrelated = [...rows[0]!.cells];
    unrelated[7] = 'OTHER';
    rows.push({ rowNumber: 20, cells: unrelated });
  });
  const worker = new Worker(store, simulatedAdapters(store), undefined, () => morning);
  const job = worker.submit(artwork, workflow, 'simulate').job;
  const duplicate = worker.submit(artwork, workflow, 'simulate');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.id, job.id);
  await worker.runAvailable();
  const done = store.get(job.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.garmentCompletions?.map(row => [row.sourceRow, row.productId, row.status]), [
    [2, 'fixture-product-101', 'completed'], [3, 'fixture-product-102', 'completed'],
  ]);
  for (const row of rows) {
    const expected = [...row.cells];
    if (row.rowNumber !== 20) expected[8] = 'Yes';
    assert.deepEqual(cells(row.rowNumber), expected);
  }
  for (const product of catalog) {
    const [current] = await shopify.findProducts(product.productSku);
    assert.deepEqual(current?.variants.map(variant => variant.sku), product.variants.map(() => product.productSku));
  }
  assert.equal(store.importSheetFixtures(rows), 0);
  assert.equal(cells(2)[8], 'Yes');
  assert.deepEqual(await worker.runAvailable(), { processed: 0, failed: [] });
  assert.ok(worker.submit(artwork, readJson('examples/sku-workflow.json', 'workflow'), 'simulate').job.id !== job.id);
});

test('dry-run queues a preview without calling either write adapter', async t => {
  const { store, artwork, shopify, sheets, cells } = await fixture(t);
  const worker = new Worker(
    store, simulatedAdapters(store), undefined, () => closed,
    { ...shopify, assignInitialSku: async () => assert.fail('dry-run attempted a Shopify write') }, undefined,
    { ...sheets, markComplete: async () => assert.fail('dry-run attempted a Sheets write') },
  );
  const job = worker.submit(artwork, workflow).job;
  await worker.runAvailable();
  assert.equal(store.get(job.id).status, 'completed');
  assert.deepEqual(store.get(job.id).garmentCompletions?.map(row => row.status), ['pending_skus', 'pending_skus']);
  assert.equal(cells(2)[8], null);
  assert.equal(cells(3)[8], null);
});

test('preserves unexpected variant SKUs while independent garments can finish', async t => {
  const { store, artwork, shopify, cells } = await fixture(t, (_, products) => {
    products[0]!.variants[0]!.sku = 'opaque-existing-hextom-sku';
  });
  const worker = new Worker(store, simulatedAdapters(store), undefined, () => morning);
  const job = worker.submit(artwork, workflow, 'simulate').job;
  await worker.runAvailable();
  const done = store.get(job.id);
  assert.equal(done.status, 'needs_review');
  assert.deepEqual(done.garmentCompletions?.map(row => [row.sourceRow, row.status, row.code]), [
    [2, 'needs_review', 'UNEXPECTED_VARIANT_SKU'], [3, 'completed', undefined],
  ]);
  assert.equal(cells(2)[8], null);
  assert.equal(cells(3)[8], 'Yes');
  assert.equal((await shopify.findProducts('000710'))[0]?.variants[0]?.sku, 'opaque-existing-hextom-sku');
  assert.equal((await shopify.findProducts('000710'))[0]?.variants[1]?.sku, null);
});

test('does not overwrite previously completed rows or other pre-existing completion values', async t => {
  const { store, artwork, cells, shopify } = await fixture(t, (rows, products) => {
    rows[0]!.cells[8] = 'Yes';
    rows[1]!.cells[8] = 'Manual hold';
    products[0]!.variants[0]!.sku = 'owner-completed-before-hextom';
  });
  const worker = new Worker(store, simulatedAdapters(store), undefined, () => morning);
  const job = worker.submit(artwork, workflow, 'simulate').job;
  await worker.runAvailable();
  assert.deepEqual(store.get(job.id).garmentCompletions?.map(row => row.status), ['already_completed', 'needs_review']);
  assert.equal(cells(2)[8], 'Yes');
  assert.equal(cells(3)[8], 'Manual hold');
  assert.equal((await shopify.findProducts('000710'))[0]?.variants[0]?.sku, 'owner-completed-before-hextom');
  assert.equal((await shopify.findProducts('000711'))[0]?.variants[0]?.sku, null);
});

test('rechecks Shopify and row identity at the completion write and guards against drift', async t => {
  const { store, path, artwork, sheets, cells } = await fixture(t, (rows, products) => {
    rows[0]!.cells[10] = 'DIFFERENT ART';
    for (const variant of products[1]!.variants) variant.sku = '000711';
  });
  const writer = {
    ...sheets,
    markComplete: async (...args: Parameters<typeof sheets.markComplete>) => {
      const db = new DatabaseSync(path);
      try {
        db.prepare('UPDATE shopify_variants SET sku = ? WHERE id = ?').run('changed-after-check', 'fixture-variant-204');
      } finally {
        db.close();
      }
      return sheets.markComplete(...args);
    },
  };
  const worker = new Worker(store, simulatedAdapters(store), undefined, () => morning, undefined, undefined, writer);
  const job = worker.submit(artwork, workflow, 'simulate').job;
  await worker.runAvailable();
  assert.deepEqual(store.get(job.id).garmentCompletions?.map(row => row.code), ['SHEET_ROW_MISMATCH', 'UNEXPECTED_VARIANT_SKU']);
  assert.equal(cells(2)[8], null);
  assert.equal(cells(3)[8], null);
});

test('resumes after an interrupted Sheets write and retains the other row checkpoint', async t => {
  const { store, path, artwork, sheets, cells } = await fixture(t);
  let now = morning;
  const writer = {
    ...sheets,
    markComplete: async (...args: Parameters<typeof sheets.markComplete>) => {
      const outcome = await sheets.markComplete(...args);
      if (outcome.sourceRow === 2) throw new WorkerError('SIMULATED_TIMEOUT', 'Interrupted after committing column I.', true);
      return outcome;
    },
  };
  const worker = new Worker(store, simulatedAdapters(store), undefined, () => now, undefined, undefined, writer);
  const job = worker.submit(artwork, workflow, 'simulate').job;
  await worker.runAvailable();
  const waiting = store.get(job.id);
  assert.equal(waiting.status, 'retry_wait');
  assert.deepEqual(waiting.garmentCompletions?.map(row => row.status), ['retry_wait', 'completed']);
  assert.equal(cells(2)[8], 'Yes');
  assert.equal(cells(3)[8], 'Yes');

  const resumed = new Store(path);
  try {
    now = waiting.availableAt;
    const reloaded = new Worker(resumed, simulatedAdapters(resumed), undefined, () => now);
    await reloaded.runAvailable();
    assert.equal(resumed.get(job.id).status, 'completed');
    assert.deepEqual(resumed.get(job.id).garmentCompletions?.map(row => row.status), ['already_completed', 'completed']);
  } finally {
    resumed.close();
  }
});

test('defers only guarded SKU work at 4:20 PM and resumes at 9:10 PM Central', async t => {
  const { store, artwork, shopify, cells } = await fixture(t, (_, products) => {
    for (const variant of products[1]!.variants) variant.sku = '000711';
  });
  let now = closed - 1;
  let writes = 0;
  const guarded = {
    ...shopify,
    assignInitialSku: async (...args: Parameters<typeof shopify.assignInitialSku>) => {
      if (++writes === 2) now = closed;
      return shopify.assignInitialSku(...args);
    },
  };
  const worker = new Worker(store, simulatedAdapters(store), undefined, () => now, guarded);
  const job = worker.submit(artwork, workflow, 'simulate').job;
  await worker.runAvailable();
  const waiting = store.get(job.id);
  assert.equal(waiting.status, 'retry_wait');
  assert.equal(waiting.failures, 0);
  assert.equal(waiting.availableAt, open);
  assert.deepEqual(waiting.garmentCompletions?.map(row => row.status), ['deferred', 'completed']);
  assert.equal(cells(2)[8], null);
  assert.equal(cells(3)[8], 'Yes');
  now = open - 60_000;
  assert.equal((await worker.runAvailable()).processed, 0);
  now = open;
  await worker.runAvailable();
  assert.equal(store.get(job.id).status, 'completed');
  assert.equal(cells(2)[8], 'Yes');
});

test('the CLI imports both fixtures and reports independent completion', async t => {
  const { dir, path, rows, catalog, cells } = await fixture(t);
  const sheetPath = join(dir, 'sheet.json');
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(sheetPath, JSON.stringify({ artwork: sheet.artwork, rows }));
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const command = (...args: string[]) => {
    const result = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--import', `data:text/javascript,Date.now=()=>${morning}`,
      'dist/src/cli.js', ...args,
    ], {
      encoding: 'utf8',
      env: { ...process.env, TEES4_DATABASE: path, TEES4_CONFIG: 'examples/completion-workflow.json' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(command('load-sheet-fixture', sheetPath), { imported: 0 });
  assert.deepEqual(command('load-shopify-fixture', catalogPath), { imported: 0 });
  const job = command('submit-sheet', sheetPath, '--mode', 'simulate');
  command('run');
  const done = command('inspect', job.jobId);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.garmentCompletions.map((row: { sourceRow: number }) => row.sourceRow), [2, 3]);
  assert.equal(cells(3)[8], 'Yes');
});
