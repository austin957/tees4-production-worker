import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { WorkerError } from '../src/model.js';
import { parseBindingAssignment, proposeProductBinding, reviewProductBinding } from '../src/product-bindings.js';
import { masterInput } from '../src/sheets.js';
import type { ProductRead } from '../src/shopify-readonly.js';
import type { SheetEvidence } from '../src/shopify-reconciliation.js';
import { Store } from '../src/store.js';

const assignment = {
  spreadsheetId: masterInput.spreadsheetId, rowNumber: 4, productSku: '001-202', artworkSku: '001',
  shopId: 'gid://shopify/Shop/1', productId: 'gid://shopify/Product/2',
};
const row = { rowNumber: assignment.rowNumber, productSku: assignment.productSku, artworkSku: assignment.artworkSku };
const snapshot: ProductRead = {
  id: assignment.productId, title: 'Fixture garment', handle: 'fixture', status: 'ACTIVE', vendor: 'Fixture vendor',
  tags: ['adjust'], productType: 'T-Shirt', publishedAt: null,
  createdAt: '2026-11-24T12:00:00Z', updatedAt: '2026-11-24T12:00:00Z',
  options: [{ id: 'color', name: 'Color', position: 1, values: ['Navy', 'Slate'] }],
  variants: ['Navy', 'Slate'].map((value, index) => ({
    id: `gid://shopify/ProductVariant/${index + 1}`, sku: index === 0 ? null : assignment.productSku,
    selectedOptions: [{ name: 'Color', value }],
  })),
};
const approval = { action: 'approve' as const, by: 'Fixture owner', source: 'reviewed-fixture-log' };
const recheck = { action: 'recheck' as const, by: 'Fixture operator' };
const nextProduct = 'gid://shopify/Product/3';

function evidence(product = snapshot, sheet: SheetEvidence = { kind: 'live', rows: [row] }) {
  return {
    shopId: assignment.shopId,
    shopify: { async product() { return structuredClone(product); } },
    async readMasterInput() { return sheet; },
  };
}

function propose(store: Store) {
  return proposeProductBinding(store, assignment, 'Fixture operator', evidence(), () => 100);
}

test('reserves the row, Shopify product and Product SKU across active records', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const initial = await propose(store);
  assert.deepEqual(parseBindingAssignment(assignment), assignment);
  assert.throws(() => parseBindingAssignment({ ...assignment, spreadsheetId: 'other' }), { code: 'SOURCE_SHEET_MISMATCH' });
  for (const proposed of [
    assignment,
    { ...assignment, rowNumber: 5, productSku: '002-202' },
    { ...assignment, productId: nextProduct, productSku: '003-202' },
    { ...assignment, productId: nextProduct, rowNumber: 5 },
  ]) {
    await assert.rejects(proposeProductBinding(store, proposed, 'Fixture operator',
      evidence({ ...snapshot, id: proposed.productId })), { code: 'BINDING_ASSIGNMENT_CONFLICT' });
  }
  assert.equal(store.listProductBindings().length, 1);
  assert.equal(store.inspectProductBinding(initial.id).history.length, 1);
  const sibling = await proposeProductBinding(store, { ...assignment, rowNumber: 5, productId: nextProduct, productSku: '001-320' },
    'Fixture operator', evidence({ ...snapshot, id: nextProduct }));
  assert.equal(sibling.status, 'proposed');
  await reviewProductBinding(store, initial.id, approval, evidence());
  await assert.rejects(propose(store), { code: 'BINDING_ASSIGNMENT_CONFLICT' });
});

test('changes to either SKU or the physical row invalidate a pending approval', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const [rows, code] of [
    [[{ ...row, artworkSku: 'different' }], 'MASTER_INPUT_CONFLICTING_ASSIGNMENT'],
    [[{ ...row, productSku: 'different' }], 'MASTER_INPUT_PRODUCT_SKU_NOT_FOUND'],
    [[{ ...row, rowNumber: 5 }], 'MASTER_INPUT_ROW_MISMATCH'],
    [[row, { ...row, rowNumber: 5 }], 'MASTER_INPUT_CONFLICTING_ASSIGNMENT'],
  ] as const) {
    const binding = await propose(store);
    const result = await reviewProductBinding(store, binding.id, approval, evidence(snapshot, { kind: 'live', rows }), () => 200);
    assert.equal(result.binding.status, 'stale');
    assert.equal(result.binding.confirmation, null);
    assert.deepEqual(result.event, {
      event: 'stale', from: 'proposed', to: 'stale', by: approval.by, at: 200, review: 'approve', code,
    });
    await assert.rejects(reviewProductBinding(store, binding.id, approval, evidence()), { code: 'BINDING_REVIEW_CONFLICT' });
  }
});

test('rejects a conflicting Shopify product or variant snapshot, including changes during review', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const cases: [ProductRead, string][] = [
    [{ ...snapshot, id: nextProduct }, 'SHOPIFY_PRODUCT_MISMATCH'],
    [{ ...snapshot, variants: [snapshot.variants[0]!, snapshot.variants[0]!] }, 'SHOPIFY_VARIANT_IDS_INVALID'],
    [{ ...snapshot, variants: [{ ...snapshot.variants[0]!, sku: 'unexpected' }, snapshot.variants[1]!] }, 'SHOPIFY_SNAPSHOT_CHANGED'],
    [{ ...snapshot, tags: [] }, 'SHOPIFY_SNAPSHOT_CHANGED'],
  ];
  for (const [product, code] of cases) {
    const binding = await propose(store);
    const result = await reviewProductBinding(store, binding.id, approval, evidence(product));
    assert.equal(result.binding.status, 'stale');
    assert.ok('code' in result.event);
    assert.equal(result.event.code, code);
  }
  const binding = await propose(store);
  let reads = 0;
  const result = await reviewProductBinding(store, binding.id, approval, {
    ...evidence(), shopify: { async product() { return ++reads === 1 ? snapshot : { ...snapshot, title: 'Changed' }; } },
  });
  assert.equal(result.binding.status, 'stale');
  assert.equal(reads, 2);
});

test('explicit approval requires live evidence on both sides of the Shopify read', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const binding = await propose(store);
  let productReads = 0;
  const shopify = { async product() { productReads++; return snapshot; } };
  await assert.rejects(reviewProductBinding(store, binding.id, { ...approval, source: '' }, evidence()), { code: 'INVALID_INPUT' });
  await assert.rejects(reviewProductBinding(store, binding.id, { ...approval, by: '' }, evidence()), { code: 'INVALID_INPUT' });
  for (const [sheet, code] of [
    [{ kind: 'fixture', reference: 'synthetic', rows: [row] }, 'LIVE_MASTER_INPUT_REQUIRED'],
    [{ kind: 'unavailable', code: 'GOOGLE_AUTH_UNAVAILABLE', message: 'Fixture 503' }, 'GOOGLE_AUTH_UNAVAILABLE'],
  ] as const) {
    const result = await reviewProductBinding(store, binding.id, approval, { ...evidence(snapshot, sheet), shopify });
    assert.equal(result.binding.status, 'proposed');
    assert.equal(result.binding.confirmation, null);
    assert.ok('code' in result.event);
    assert.equal(result.event.code, code);
  }
  assert.equal(productReads, 0);
  let sheetReads = 0;
  const changed = await reviewProductBinding(store, binding.id, approval, {
    ...evidence(), shopify,
    async readMasterInput() { return { kind: 'live', rows: ++sheetReads === 1 ? [row] : [] }; },
  });
  assert.equal(changed.binding.status, 'stale');
  assert.equal(sheetReads, 2);
  assert.equal(productReads, 2);
  assert.deepEqual(store.inspectProductBinding(binding.id).history.map(entry => entry.event),
    ['proposed', 'verification_failed', 'verification_failed', 'stale']);
});

test('a concurrent rejection prevents a delayed approval from committing', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const binding = await propose(store);
  const gate = Promise.withResolvers<void>();
  const pending = reviewProductBinding(store, binding.id, approval, {
    ...evidence(), async readMasterInput() { await gate.promise; return { kind: 'live', rows: [row] }; },
  });
  store.recordProductBindingReview(binding.id, { event: 'rejected', by: 'Fixture owner', at: 200, reason: 'Wrong garment' });
  gate.resolve();
  await assert.rejects(pending, { code: 'BINDING_REVIEW_CONFLICT' });
  assert.equal(store.getProductBinding(binding.id).status, 'rejected');
  assert.equal(store.inspectProductBinding(binding.id).history.length, 2);
  const replacement = await propose(store);
  assert.notEqual(replacement.id, binding.id);
});

test('persists approval and append-only history across SQLite and CLI restarts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tees4-bindings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'worker.sqlite');
  const first = new Store(path);
  const binding = await propose(first);
  const approved = await reviewProductBinding(first, binding.id, approval, evidence(), () => 200);
  assert.equal(approved.binding.status, 'approved');
  const rejected = await proposeProductBinding(first, { ...assignment, rowNumber: 5, productId: nextProduct, productSku: '001-320' },
    'Fixture operator', evidence({ ...snapshot, id: nextProduct }));
  first.close();
  const cli = (...args: string[]) => spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', 'dist/src/cli.js', ...args,
  ], { env: { ...process.env, TEES4_DATABASE: path }, encoding: 'utf8' });
  const invoke = (...args: string[]) => {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const listed = invoke('binding-list');
  assert.equal(listed.find((item: { id: string }) => item.id === binding.id).status, 'approved');
  const inspection = invoke('binding-inspect', binding.id);
  assert.deepEqual(inspection.binding.confirmation, { by: approval.by, source: approval.source, at: 200 });
  assert.deepEqual(inspection.history, [
    { event: 'proposed', by: 'Fixture operator', at: 100, from: null, to: 'proposed' },
    { event: 'approved', by: approval.by, at: 200, source: approval.source, from: 'proposed', to: 'approved' },
  ]);
  assert.equal(cli('binding-review', rejected.id, 'approve', '--by', 'Fixture owner').status, 1);
  assert.equal(cli('binding-review', rejected.id, 'approve', '--by', 'Fixture owner', '--source', 'fixture',
    '--sheet-fixture', 'invalid.json').status, 1);
  assert.equal(invoke('binding-review', rejected.id, 'reject', '--by', 'Fixture owner', '--reason', 'Wrong garment').binding.status, 'rejected');
  const second = new Store(path);
  try {
    assert.equal((await reviewProductBinding(second, binding.id, recheck, evidence(), () => 300)).event.event, 'revalidated');
    const result = await reviewProductBinding(second, binding.id, recheck,
      evidence({ ...snapshot, variants: [{ ...snapshot.variants[0]!, id: 'gid://shopify/ProductVariant/8' }, snapshot.variants[1]!] }), () => 400);
    assert.equal(result.binding.status, 'stale');
    assert.deepEqual(result.binding.confirmation, inspection.binding.confirmation);
  } finally {
    second.close();
  }
  const db = new DatabaseSync(path);
  try {
    for (const sql of [
      "UPDATE product_binding_events SET body = '{}'",
      'DELETE FROM product_binding_events',
      "INSERT OR REPLACE INTO product_binding_events SELECT sequence, binding_id, '{}' FROM product_binding_events",
    ]) assert.throws(() => db.exec(sql), /append-only/);
  } finally {
    db.close();
  }
  assert.deepEqual(invoke('binding-inspect', binding.id).history.map((entry: { event: string }) => entry.event),
    ['proposed', 'approved', 'revalidated', 'stale']);
});

test('proposes through the CLI using read-only Shopify and preserves pending status after a simulated OIDC failure', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tees4-binding-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, 'mock # fixture.mjs');
  const input = join(directory, 'assignment.json');
  const domain = 'fixture.myshopify.com';
  const product = {
    ...snapshot,
    options: snapshot.options.map(({ values, ...option }) => ({ ...option, optionValues: values.map(name => ({ name })) })),
    variants: { nodes: snapshot.variants, pageInfo: { hasNextPage: false } },
  };
  writeFileSync(input, JSON.stringify(assignment));
  writeFileSync(preload, `
    import { createRequire } from 'node:module';
    import { join } from 'node:path';
    const { GoogleAuth } = createRequire(join(process.cwd(), 'package.json'))('google-auth-library');
    GoogleAuth.prototype.getClient = async () => { throw Object.assign(new Error('Fixture impersonation failure'), { code: 503 }); };
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      if (url.hostname !== ${JSON.stringify(domain)}) throw new Error('Unexpected host');
      if (url.pathname === '/admin/oauth/access_token') return Response.json({ access_token: 'fixture-token', expires_in: 86400 });
      const { query } = JSON.parse(init.body);
      const data = query.startsWith('query Tees4ReadIdentity') ? {
        shop: { id: ${JSON.stringify(assignment.shopId)}, myshopifyDomain: url.hostname },
        currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] },
      } : query.startsWith('query Tees4ReadProduct(') ? { product: ${JSON.stringify(product)} } : null;
      if (!data) throw new Error('Unexpected Shopify operation');
      return Response.json({ data }, { headers: { 'X-Shopify-API-Version': '2026-10' } });
    };
  `);
  const cli = (...args: string[]) => spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', '--import', pathToFileURL(preload).href, 'dist/src/cli.js', ...args,
  ], { env: {
    ...process.env, TEES4_DATABASE: join(directory, 'worker.sqlite'), TEES4_SHOPIFY_DOMAIN: domain,
    TEES4_SHOPIFY_SHOP_ID: assignment.shopId, TEES4_SHOPIFY_API_VERSION: '2026-10',
    TEES4_SHOPIFY_CLIENT_ID: 'fixture-id', TEES4_SHOPIFY_CLIENT_SECRET: 'fixture-secret',
  }, encoding: 'utf8' });
  const proposed = cli('binding-propose', input, '--by', 'Fixture operator');
  assert.equal(proposed.status, 0, proposed.stderr);
  const binding = JSON.parse(proposed.stdout);
  assert.equal(binding.status, 'proposed');
  assert.deepEqual(binding.shopifySnapshot.variants, snapshot.variants);
  const review = cli('binding-review', binding.id, 'approve', '--by', approval.by, '--source', approval.source);
  assert.equal(review.status, 1);
  const result = JSON.parse(review.stdout);
  assert.equal(result.binding.status, 'proposed');
  assert.equal(result.binding.confirmation, null);
  assert.equal(result.event.code, 'GOOGLE_AUTH_UNAVAILABLE');
  assert.equal(result.event.event, 'verification_failed');
});
