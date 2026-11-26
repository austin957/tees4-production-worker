import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GoogleAuth } from 'google-auth-library';
import { readMasterInputSupervisedRows } from '../src/google-sheets.js';
import { pilotMockupifyDryRun } from '../src/mockupify-writer-cli.js';
import { previewMockupifyOperation } from '../src/mockupify-writer.js';
import { WorkerError } from '../src/model.js';
import { Store } from '../src/store.js';
import { FakeMockupify, initialTime, input, png, prepare, productGid, readyToExport, review, shop } from './mockupify-writer-fixture.js';

test('the offline pilot dry run identifies row 9 and preserves the source artwork name and Shopify title', () => {
  const trace = pilotMockupifyDryRun();
  assert.match(trace.evidence, /row 9 fixture/);
  assert.deepEqual(trace.source, {
    spreadsheetId: '1UxdIY03ICu5t2G0fEo0nor6-giAEF4xdMuNEvYN_JMM', worksheet: 'Master Input', row: 9,
    sheetArtworkName: 'SKU TEST', productTitle: 'Bold Arrow Emblem', artworkRegistryName: 'Bold Arrow Emblem',
    artworkNameDiscrepancy: 'preserved_source_name', productSku: '8419620257-S105', artworkSku: '8419620257',
    garment: 'Adult Tank Top',
  });
  assert.equal(trace.template.templateId, 10779);
  assert.deepEqual(trace.colors.map(color => [color.id, color.review]), [[20514, 'owner_approved'], [20515, 'owner_approved']]);
  assert.deepEqual(trace.trace.at(-1), {
    system: 'Shopify', status: 'awaiting_product_gid_and_shop_verification',
    expectedProductStatus: 'ACTIVE', expectedSalesChannelPublications: 0,
  });
  assert.equal(trace.executionAuthorized, false);
  assert.equal(trace.httpRequests, 0);
  assert.equal(trace.journalClaims, 0);
});

test('preparation rejects a stale selected row, then accepts the same identifiers at their verified physical row', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const source = api.rows[0]!;
  source.sourceRow = 27;
  api.rows.push({ ...source, sourceRow: input.source.row, productSku: '000124-S105' });
  await assert.rejects(api.writer(store).prepare(input, review, png), { code: 'MOCKUPIFY_SOURCE_CHANGED' });
  assert.deepEqual(api.requests, []);

  const journal = await api.writer(store).prepare({ ...input, source: { ...input.source, row: 27 } }, review, png);
  assert.equal(journal.plan.correlation.sourceRow, 27);
  assert.equal(journal.plan.source.sheetArtworkName, 'Fixture artwork');
  assert.equal(journal.plan.source.title, 'Fixture title');
});

test('preparation requires both reviewed vendors to match the exact, nonblank Column D value', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const writer = api.writer(store);
  const vendor = 'Another Fixture Vendor';
  const approved = structuredClone(review);
  approved.design.vendor = approved.product.vendor = vendor;

  for (const sourceVendor of [null, '   ', review.design.vendor]) {
    api.rows[0]!.vendor = sourceVendor;
    await assert.rejects(writer.prepare(input, approved, png), { code: 'MOCKUPIFY_VENDOR_MISMATCH' });
  }
  api.rows[0]!.vendor = vendor;
  for (const field of ['design', 'product'] as const) {
    for (const wrongVendor of [undefined, '', vendor.toLowerCase(), `${vendor} `]) {
      const mismatched = structuredClone(approved);
      if (wrongVendor === undefined) Reflect.deleteProperty(mismatched[field], 'vendor');
      else mismatched[field].vendor = wrongVendor;
      await assert.rejects(writer.prepare(input, mismatched, png), { code: 'MOCKUPIFY_VENDOR_MISMATCH' });
    }
  }
  assert.deepEqual(api.requests, []);

  const { plan } = await writer.prepare(input, approved, png);
  assert.equal(plan.source.vendor, vendor);
  assert.equal(plan.review.design.vendor, vendor);
  assert.equal(plan.review.product.vendor, vendor);
});

test('dispatch rejects a previously stored review with incorrect vendors even with exact operation approval', async t => {
  const store = new Store(':memory:');
  const legacyStore = new Store(':memory:');
  t.after(() => { store.close(); legacyStore.close(); });
  const api = new FakeMockupify();
  const { plan } = await api.writer(store).prepare(input, review, png);
  plan.review.design.vendor = plan.review.product.vendor = 'Incorrect fixture vendor';
  legacyStore.registerMockupifyPlan(plan);
  const id = plan.correlation.correlationId;
  const approval = api.approve(legacyStore, id, 'create_batch');
  api.requests.length = 0;

  await assert.rejects(api.writer(legacyStore).dispatch(id, 'create_batch', approval), { code: 'MOCKUPIFY_VENDOR_MISMATCH' });
  assert.deepEqual(api.requests, []);
  assert.deepEqual(legacyStore.getMockupifyJournal(id).claims, {});
});

test('dispatch rejects missing, ambiguous or mismatched Sheet identities before requests or claims', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await prepare(store, api);
  const source = api.rows[0]!;
  const writer = api.writer(store);
  const approval = api.approve(store, id, 'create_batch');
  api.requests.length = 0;
  for (const rows of [
    [], [{ ...source, sourceRow: 36 }], [{ ...source, productSku: 'different' }],
    [{ ...source, artworkSku: 'different' }], [{ ...source, garment: 'Adult Shirt' }],
    [{ ...source, vendor: null }], [{ ...source, vendor: 'Changed fixture vendor' }],
    [source, { ...source, sourceRow: 36 }], [source, { ...source, productSku: 'different' }],
  ]) {
    api.rows = rows;
    await assert.rejects(writer.dispatch(id, 'create_batch', approval), { code: 'MOCKUPIFY_SOURCE_CHANGED' });
  }
  assert.deepEqual(api.requests, []);
  assert.deepEqual(store.getMockupifyJournal(id).claims, {});
});

test('dispatch rechecks the Sheet after vendor preflight before claiming the operation', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await prepare(store, api);
  const source = api.rows[0]!;
  for (const changed of [{ ...source, sourceRow: 36 }, { ...source, vendor: 'Changed fixture vendor' }]) {
    api.rows = [source];
    api.beforeRead = () => { api.rows = [changed]; };
    await assert.rejects(api.writer(store).dispatch(id, 'create_batch', api.approve(store, id, 'create_batch')),
      { code: 'MOCKUPIFY_SOURCE_CHANGED' });
  }
  assert.deepEqual(api.posts, []);
  assert.deepEqual(store.getMockupifyJournal(id).claims, {});
});

test('production preparation fails closed when the authoritative Sheet reader is unavailable', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const auth = t.mock.method(GoogleAuth.prototype, 'getClient', async () => { throw new Error('Fixture unavailable'); });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected live request'); });
  await assert.rejects(api.writer(store, 'production').prepare(input, review, png), { code: 'GOOGLE_AUTH_UNAVAILABLE' });
  assert.equal(auth.mock.callCount(), 1);
  assert.equal(fetch.mock.callCount(), 0);
});

test('dry-run, wrong or expired approval, and unverified durability prevent all production POST attempts', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await prepare(store, api);
  const valid = api.approve(store, id, 'create_batch');
  const realFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected live request'); });
  const production = api.writer(store, 'production');
  await assert.rejects(production.dispatch(id, 'create_batch'), { code: 'MOCKUPIFY_APPROVAL_REQUIRED' });
  await assert.rejects(api.writer(store, 'dry_run').dispatch(id, 'create_batch', valid), { code: 'MOCKUPIFY_DRY_RUN' });
  for (const approval of [undefined, { ...valid, expiresAt: api.now }, { ...valid, digest: 'different' },
    { ...valid, operation: 'start_export' as const }]) {
    await assert.rejects(api.writer(store).dispatch(id, 'create_batch', approval), { code: 'MOCKUPIFY_APPROVAL_REQUIRED' });
  }
  await assert.rejects(production.dispatch(id, 'create_batch', valid), { code: 'MOCKUPIFY_DURABLE_STORAGE_REQUIRED' });
  t.mock.method(store, 'hasVerifiedMockupifyDurability', () => true);
  await assert.rejects(production.dispatch(id, 'create_batch', valid), { code: 'MOCKUPIFY_MODE_MISMATCH' });
  assert.deepEqual(api.posts, []);
  assert.deepEqual(store.getMockupifyJournal(id).claims, {});
  assert.equal(realFetch.mock.callCount(), 0);
});

test('all three documented requests are claimed before dispatch and validated evidence leaves binding review separate', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await prepare(store, api);
  const writer = api.writer(store);
  const operations = ['create_batch', 'upload_design', 'start_export'] as const;
  for (const operation of operations) {
    const before = store.getMockupifyJournal(id);
    const preview = previewMockupifyOperation(before, operation);
    const approval = api.approve(store, id, operation);
    api.afterPost = async () => {
      const claim = store.getMockupifyJournal(id).claims[operation];
      assert.equal(claim?.state, 'dispatching');
      assert.equal(claim?.requestDigest, preview.requestDigest);
      assert.deepEqual(claim.approval, approval);
      assert.deepEqual(claim.request, preview.request);
    };
    const after = await writer.dispatch(id, operation, approval, png);
    assert.equal(after.claims[operation]?.state, 'acknowledged');
  }
  assert.equal((await writer.reconcile(id)).exportStatus, 'pending');
  api.finish();
  const verified = await writer.reconcile(id);
  assert.equal(verified.exportStatus, 'validated_for_binding_review');
  assert.deepEqual([verified.batchId, verified.designId, verified.exportId, verified.shopifyProductGid], [71, 72, 301, productGid]);
  assert.equal(verified.plan.correlation.sourceRow, 9);
  assert.deepEqual(api.shopifyReads, [productGid, productGid]);
  assert.deepEqual(api.posts, ['/api/batches/', '/api/designs/', '/api/exports/']);
  assert.deepEqual(store.listProductBindings(), []);
});

test('timeout after export dispatch holds the POST and reconciles partial Shopify output by explicit IDs', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await readyToExport(store, api);
  api.afterPost = async () => { throw new DOMException('Injected timeout', 'TimeoutError'); };
  const writer = api.writer(store);
  const approval = api.approve(store, id, 'start_export');
  const lost = await writer.dispatch(id, 'start_export', approval);
  assert.equal(lost.exportId, null);
  assert.equal(lost.claims.start_export?.state, 'uncertain');
  await assert.rejects(writer.dispatch(id, 'start_export', approval), { code: 'MOCKUPIFY_ALREADY_CLAIMED' });
  api.finish([11]);
  api.exports[0]!.errors.push({ design: 72, product: 10779, at: new Date(initialTime).toISOString(), message: 'fixture failure' });
  const partial = await writer.reconcile(id);
  assert.equal(partial.exportId, 301);
  assert.equal(partial.claims.start_export?.state, 'recovered');
  assert.equal(partial.exportStatus, 'held');
  assert.equal(partial.shopifyProductGid, null);
  assert.deepEqual(partial.observedProductGids, [productGid]);
  assert.deepEqual(api.shopifyReads, [productGid, productGid]);
  const history = JSON.stringify(store.inspectMockupifyJournal(id).history);
  assert.match(history, /"errors":\[\{"designId":72,"productId":10779/);
  assert.match(history, /"shopifyProductId":"9999"/);
  assert.equal(api.posts.filter(path => path === '/api/exports/').length, 1);
  assert.deepEqual(store.listProductBindings(), []);
});

test('a process exit after applying the batch POST retains the committed claim on restart and restoration', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tees4-journal-'));
  const path = join(dir, 'journal.sqlite');
  const remote = join(dir, 'remote.json');
  const restored = join(dir, 'restore.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fixture = new URL('./mockupify-writer-fixture.js', import.meta.url).href;
  const storeModule = new URL('../src/store.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { FakeMockupify, prepare } from ${JSON.stringify(fixture)};
    import { Store } from ${JSON.stringify(storeModule)};
    const [path, remote] = process.argv.slice(1);
    const store = new Store(path);
    const api = new FakeMockupify();
    const id = await prepare(store, api);
    api.afterPost = async (_path, batch) => {
      writeFileSync(remote, JSON.stringify({ id, batch }));
      process.exit(23);
    };
    await api.writer(store).dispatch(id, 'create_batch', api.approve(store, id, 'create_batch'));
  `, path, remote], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  assert.ifError(child.error);
  assert.equal(child.status, 23, child.stderr);
  const { id, batch } = JSON.parse(readFileSync(remote, 'utf8')) as { id: string; batch: FakeMockupify['batches'][number] };
  using original = new DisposableStack();
  const restarted = original.adopt(new Store(path), store => store.close());
  const claim = restarted.getMockupifyJournal(id).claims.create_batch!;
  assert.equal(claim.state, 'dispatching');

  const assignment = {
    spreadsheetId: restarted.getMockupifyJournal(id).plan.correlation.spreadsheetId,
    rowNumber: 15, productSku: 'OTHER', artworkSku: 'OTHER-ART', shopId: shop.id, productId: productGid,
  };
  const binding = restarted.createProductBinding(assignment, 'Fixture operator', fakeProduct(), initialTime);
  await restarted.backupTo(restored);
  await assert.rejects(restarted.backupTo(restored), { code: 'EEXIST' });
  const expectedHistory = restarted.inspectMockupifyJournal(id);
  const expectedBindingHistory = restarted.inspectProductBinding(binding.id);
  original.dispose();

  using restoration = new DisposableStack();
  const store = restoration.adopt(new Store(restored), store => store.close());
  assert.deepEqual(store.inspectMockupifyJournal(id), expectedHistory);
  assert.deepEqual(store.inspectProductBinding(binding.id), expectedBindingHistory);
  assert.equal(store.getMockupifyJournal(id).claims.create_batch?.requestDigest, claim.requestDigest);
  assert.equal(store.getMockupifyJournal(id).plan.correlation.correlationId, id);
  assert.equal(store.hasVerifiedMockupifyDurability(), false);
  const api = new FakeMockupify();
  api.batches.push(batch);
  const writer = api.writer(store);
  await assert.rejects(writer.dispatch(id, 'create_batch', claim.approval), { code: 'MOCKUPIFY_ALREADY_CLAIMED' });
  await assert.rejects(writer.reconcile(id), { code: 'MOCKUPIFY_DISPATCH_IN_FLIGHT' });
  api.now += 15_001;
  assert.equal((await writer.reconcile(id)).batchId, null);
  const recovered = await writer.reconcile(id, {
    operation: 'create_batch', remoteId: batch.id, requestDigest: claim.requestDigest,
    by: 'Fixture owner', evidence: 'Fixture ownership inspection', dispatcherStoppedEvidence: 'Child exited with code 23',
  });
  assert.equal(recovered.batchId, batch.id);
  assert.equal(recovered.claims.create_batch?.state, 'recovered');
  assert.deepEqual(api.posts, []);
});

function fakeProduct() {
  return {
    id: productGid, title: 'Fixture', handle: 'fixture', vendor: 'Fixture', productType: '', status: 'DRAFT',
    publishedAt: null, createdAt: new Date(initialTime).toISOString(), updatedAt: new Date(initialTime).toISOString(),
    options: [], variants: [{ id: 'gid://shopify/ProductVariant/8', sku: null, selectedOptions: [] }], tags: [],
  };
}

test('two workers sharing SQLite cannot send simultaneous POSTs for a Product SKU', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tees4-concurrency-'));
  const first = new Store(join(dir, 'journal.sqlite'));
  const second = new Store(join(dir, 'journal.sqlite'));
  t.after(() => { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); });
  const api = new FakeMockupify();
  const id = await prepare(first, api);
  const approval = api.approve(first, id, 'create_batch');
  const sent = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  api.afterPost = async () => { sent.resolve(); await reply.promise; };
  const dispatch = api.writer(first).dispatch(id, 'create_batch', approval);
  await sent.promise;
  try {
    await assert.rejects(api.writer(second).dispatch(id, 'create_batch', approval), { code: 'MOCKUPIFY_ALREADY_CLAIMED' });
    await assert.rejects(api.writer(second).dispatch(id, 'upload_design'), { code: 'MOCKUPIFY_PREREQUISITE' });
  } finally {
    reply.resolve();
    await dispatch;
  }
  assert.deepEqual(api.posts, ['/api/batches/']);
});

test('wrong batch members, wrong shop, changed source and restricted times block export before a claim', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await readyToExport(store, api);
  const writer = api.writer(store);
  async function reject(code: string) {
    await assert.rejects(writer.dispatch(id, 'start_export', api.approve(store, id, 'start_export')), { code });
    assert.equal(store.getMockupifyJournal(id).claims.start_export, undefined);
    assert.equal(api.posts.length, 2);
  }
  api.designs.push({ ...api.designs[0]!, id: 73 });
  await reject('MOCKUPIFY_BATCH_MEMBERSHIP');
  api.designs.pop();
  api.designs[0]!.design_id = 'wrong-reference';
  await reject('MOCKUPIFY_DESIGN_MISMATCH');
  api.designs[0]!.design_id = store.getMockupifyJournal(id).plan.correlation.designReference;
  api.shop.id = 'gid://shopify/Shop/8';
  await reject('MOCKUPIFY_WRONG_SHOP');
  api.shop = { ...shop };
  api.rows[0]!.description = 'changed';
  await reject('MOCKUPIFY_SOURCE_CHANGED');
  api.rows[0]!.description = 'Fixture description';
  api.now = Date.parse('2026-01-02T22:20:00Z');
  await reject('MOCKUPIFY_WINDOW');
  api.now = Date.parse('2026-01-02T21:50:00Z');
  await reject('EXPORT_SAFETY_MARGIN');

  api.now = initialTime;
  api.beforeRead = path => { if (path === '/api/designs/') api.now = Date.parse('2026-01-02T22:20:00Z'); };
  await reject('MOCKUPIFY_WINDOW');
});

test('Shopify GIDs stay held on wrong shop or vendor, non-Active products, empty output and numeric-only evidence', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await readyToExport(store, api);
  const writer = api.writer(store);
  await writer.dispatch(id, 'start_export', api.approve(store, id, 'start_export'));
  api.finish();
  api.shop.domain = 'other.myshopify.com';
  assert.equal((await writer.reconcile(id)).exportStatus, 'held');
  assert.deepEqual(api.shopifyReads, []);
  api.shop = { ...shop };
  api.productOverride.status = 'DRAFT';
  assert.equal((await writer.reconcile(id)).exportStatus, 'held');
  api.productOverride = { vendor: 'Incorrect fixture vendor' };
  assert.equal((await writer.reconcile(id)).exportStatus, 'held');
  api.productOverride = {};
  api.exports[0]!.products[0]!.shopify_product_gid = null;
  assert.equal((await writer.reconcile(id)).exportStatus, 'held');
  api.exports[0]!.products = [];
  assert.equal((await writer.reconcile(id)).exportStatus, 'held');
  assert.deepEqual(store.getMockupifyJournal(id).observedProductGids, [productGid]);
});

test('429 on POST is held with persistent Retry-After and no automatic POST retry', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await prepare(store, api);
  api.responseOverride = path => path === '/api/batches/' && api.posts.length ?
    new Response(null, { status: 429, headers: { 'Retry-After': '10' } }) : undefined;
  const writer = api.writer(store);
  const attempted = await writer.dispatch(id, 'create_batch', api.approve(store, id, 'create_batch'));
  assert.equal(attempted.claims.create_batch?.state, 'uncertain');
  await assert.rejects(writer.reconcile(id), { code: 'MOCKUPIFY_RATE_LIMITED' });
  api.now += 10_001;
  api.responseOverride = () => undefined;
  assert.equal((await writer.reconcile(id)).batchId, null);
  assert.deepEqual(api.posts, ['/api/batches/']);
});

test('a source discrepancy requires resolution and the read-only sheet adapter preserves exact A–K strings', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  api.rows[0]!.sheetArtworkName = 'Different artwork name';
  await assert.rejects(api.writer(store).prepare({
    ...input, source: { ...input.source, sheetArtworkName: 'Different artwork name' },
  }, review, png), { code: 'MOCKUPIFY_REVIEW_REQUIRED' });
  assert.deepEqual(api.requests, []);
  const rows = await readMasterInputSupervisedRows(7, 'Product', async url => {
    assert.match(url.pathname, /A7%3AK/);
    assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
    return { values: [
      ['Artwork Name(From Google Drive)', 'Product Title', 'Product Description', 'Vendor', 'Product', 'Colors', 'Tags', 'Product SKU',
        'Tees-4 Completed', '', 'Artwork SKU'],
      ['Artwork', 'Title', 'Description', 'Vendor', 'Adult Tank Top', '50, 00', 'tag', '0001-S105', '', '', '0001'],
    ] };
  });
  assert.deepEqual(rows, [{
    sourceRow: 8, sheetArtworkName: 'Artwork', title: 'Title', description: 'Description', vendor: 'Vendor',
    garment: 'Adult Tank Top', rawColors: '50, 00', tags: 'tag', productSku: '0001-S105', completion: null, artworkSku: '0001',
  }]);
});

test('a lost upload acknowledgment needs independent artwork evidence before export can be approved', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await prepare(store, api);
  const writer = api.writer(store);
  await writer.dispatch(id, 'create_batch', api.approve(store, id, 'create_batch'));
  const approval = api.approve(store, id, 'upload_design');
  await assert.rejects(writer.dispatch(id, 'upload_design', approval, Buffer.of(1)), { code: 'MOCKUPIFY_PNG_EVIDENCE_MISMATCH' });
  api.afterPost = async () => { throw new Error('Injected disconnect after upload'); };
  const uploaded = await writer.dispatch(id, 'upload_design', approval, png);
  const claim = uploaded.claims.upload_design!;
  assert.equal(claim.state, 'uncertain');
  assert.equal((await writer.reconcile(id)).designId, null);
  assert.throws(() => previewMockupifyOperation(store.getMockupifyJournal(id), 'start_export'), { code: 'MOCKUPIFY_PREREQUISITE' });
  const proof = {
    operation: 'upload_design' as const, remoteId: 72, requestDigest: claim.requestDigest, by: 'Fixture reviewer',
    evidence: 'Fixture verified design download', dispatcherStoppedEvidence: 'Original request disconnected',
  };
  assert.equal((await writer.reconcile(id, { ...proof, artworkSha256: '0'.repeat(64) })).designId, null);
  const recovered = await writer.reconcile(id, { ...proof, artworkSha256: input.png.preparedSha256 });
  assert.equal(recovered.designId, 72);
  assert.equal(recovered.claims.upload_design?.state, 'recovered');
  await assert.rejects(writer.dispatch(id, 'upload_design', approval, png), { code: 'MOCKUPIFY_ALREADY_CLAIMED' });
  assert.deepEqual(api.posts, ['/api/batches/', '/api/designs/']);
});

test('live catalog price drift, running exports and active bindings pause dispatch', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await readyToExport(store, api);
  const writer = api.writer(store);
  const approval = api.approve(store, id, 'start_export');
  const black = api.catalog.find(entry => entry.id === 10779)!.colors[0]!;
  black.price = '99.99';
  await assert.rejects(writer.dispatch(id, 'start_export', approval), { code: 'MOCKUPIFY_CATALOG_CHANGED' });
  black.price = '5.00';
  const exportFixture = api.makeExport(api.batches[0]!, api.designs[0]!, [11]);
  api.exports.push(exportFixture, { ...exportFixture, id: 302 });
  await assert.rejects(writer.dispatch(id, 'start_export', approval), { code: 'MOCKUPIFY_EXPORT_CAPACITY' });
  api.exports = [];
  const { correlation } = store.getMockupifyJournal(id).plan;
  store.createProductBinding({
    spreadsheetId: correlation.spreadsheetId, rowNumber: correlation.sourceRow, artworkSku: correlation.artworkSku,
    productSku: correlation.productSku, shopId: shop.id, productId: productGid,
  }, 'Fixture operator', fakeProduct(), api.now);
  await assert.rejects(writer.dispatch(id, 'start_export', approval), { code: 'MOCKUPIFY_BINDING_CONFLICT' });
  assert.equal(store.getMockupifyJournal(id).claims.start_export, undefined);
  assert.deepEqual(api.posts, ['/api/batches/', '/api/designs/']);
});

test('the supervised request journal enforces the hourly account quota with a rolling window', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (let index = 0; index < 1200; index++) store.reserveMockupifyRead(initialTime);
  assert.throws(() => store.reserveMockupifyRead(initialTime + 3_599_999), { code: 'MOCKUPIFY_RATE_LIMITED' });
  store.reserveMockupifyRead(initialTime + 3_600_000);
});

test('the pilot blocks export without publication read access or enough verified time before Hextom can publish', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const writer = api.writer(store);
  await assert.rejects(writer.prepare(input, { ...review, publicationSafety: { ...review.publicationSafety, evidence: '' } }, png),
    { code: 'MOCKUPIFY_PUBLICATION_SAFETY_REQUIRED' });
  const id = await readyToExport(store, api);
  api.verifyPublicationAccess = async () => { throw new WorkerError('SHOPIFY_PERMISSION', 'Fixture publication access denied'); };
  await assert.rejects(writer.dispatch(id, 'start_export', api.approve(store, id, 'start_export')),
    { code: 'SHOPIFY_PERMISSION' });
  api.verifyPublicationAccess = async () => {};
  api.now = review.publicationSafety.endsAt - review.publicationSafety.minimumMinutes * 60_000;
  await assert.rejects(writer.dispatch(id, 'start_export', api.approve(store, id, 'start_export')),
    { code: 'MOCKUPIFY_PUBLICATION_WINDOW' });
  assert.equal(store.getMockupifyJournal(id).claims.start_export, undefined);
  assert.deepEqual(api.posts, ['/api/batches/', '/api/designs/']);
});

test('a live or staged sales-channel publication holds the pilot even with Active status and a null Online Store timestamp', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await readyToExport(store, api);
  const writer = api.writer(store);
  await writer.dispatch(id, 'start_export', api.approve(store, id, 'start_export'));
  api.finish();
  api.productOverride.hasSalesChannelPublication = true;
  const published = await writer.reconcile(id);
  assert.equal(published.exportStatus, 'held');
  assert.equal(published.shopifyProductGid, null);
  assert.equal(published.publicationObserved, true);
  api.productOverride.hasSalesChannelPublication = false;
  assert.equal((await writer.reconcile(id)).exportStatus, 'held');
});

test('the pilot stays held on missing publication evidence or after the verified Hextom-safe window', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const api = new FakeMockupify();
  const id = await readyToExport(store, api);
  const writer = api.writer(store);
  await writer.dispatch(id, 'start_export', api.approve(store, id, 'start_export'));
  api.finish();
  api.includePublicationEvidence = false;
  assert.equal((await writer.reconcile(id)).exportStatus, 'held');
  api.includePublicationEvidence = true;
  assert.equal((await writer.reconcile(id)).exportStatus, 'validated_for_binding_review');
  api.now = review.publicationSafety.endsAt;
  assert.equal((await writer.reconcile(id)).exportStatus, 'held');
  const detail = api.exports[0]!;
  detail.status = 'exporting';
  detail.products = [];
  assert.equal((await writer.reconcile(id)).exportStatus, 'held');
});
