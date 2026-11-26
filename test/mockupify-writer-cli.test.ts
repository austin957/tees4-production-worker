import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { GoogleAuth } from 'google-auth-library';
import { mockupifyPilot } from '../src/mockupify-pilot.js';
import { mockupifyCorrelation } from '../src/mockupify-preparation.js';
import { runMockupifyWriterCommand } from '../src/mockupify-writer-cli.js';
import { mockupifyOperations } from '../src/mockupify-writer-model.js';
import type { MockupifyOperation } from '../src/mockupify-writer-model.js';
import { masterInput } from '../src/sheets.js';
import { ShopifyReadonlyClient } from '../src/shopify-readonly.js';
import { Store } from '../src/store.js';
import { FakeMockupify, input, png, readyToExport, review } from './mockupify-writer-fixture.js';

function localFiles(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tees4 writer cli '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  function json(name: string, value: unknown) {
    const path = join(directory, name);
    writeFileSync(path, '\uFEFF' + JSON.stringify(value));
    return path;
  }
  const artwork = join(directory, 'reviewed file.png');
  writeFileSync(artwork, png);
  return { directory, database: join(directory, 'worker.sqlite'), json, artwork };
}

function pilotFixture() {
  const pilot = mockupifyPilot;
  const api = new FakeMockupify();
  const source = {
    ...api.rows[0]!, sourceRow: pilot.row, sheetArtworkName: pilot.sheetArtworkName, title: pilot.title,
    artworkSku: pilot.artworkSku, productSku: pilot.productSku, vendor: pilot.vendor, tags: pilot.tags.join(', '),
  };
  const correlation = mockupifyCorrelation(masterInput.spreadsheetId, source.productSku);
  const catalogColors = pilot.colors.map(color => ({
    ...color, price: pilot.catalogPrice, sizes: ['X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large'],
  }));
  api.catalog.find(product => product.id === pilot.templateId)!.colors = catalogColors;
  const metadata = structuredClone(review);
  metadata.artworkRegistryName = metadata.design.title = pilot.title;
  metadata.artworkNameResolution = 'Synthetic source name evidence';
  metadata.designerAttribution = pilot.attribution;
  metadata.design.description = 'Synthetic description\r\nTees-4';
  metadata.design.extra_title = '';
  metadata.design.vendor = metadata.product.vendor = pilot.vendor;
  metadata.design.search_tags = source.tags;
  metadata.product.title = 'Synthetic exact Shopify title';
  metadata.product.descriptionHtml = '<p>Synthetic description Tees-4</p>';
  metadata.product.tags = [...pilot.tags];
  metadata.product.variants = catalogColors.flatMap(color => color.sizes.map(size => ({
    options: { Color: color.name, Size: size }, price: '12.34',
  })));
  metadata.shop = { id: pilot.shopId, domain: pilot.shopDomain, connectionEvidence: 'Synthetic shop evidence' };
  const colors = input.supplierColors.map((color, index) => ({ ...color, mockupifyColorId: catalogColors[index]!.id, brand: 'Tultex' as const }));
  const artwork = { ...input.png, preparedSha256: pilot.pngSha256 };
  const preparation = {
    source: {
      ...input.source, row: source.sourceRow, sheetArtworkName: source.sheetArtworkName,
      title: source.title, productSku: source.productSku, artworkSku: source.artworkSku,
    },
    supplierColors: colors, png: artwork,
  };
  return { api, source, correlation, catalogColors, metadata, colors, artwork, preparation };
}

test('the worker CLI prints exact local previews for all three operations with no credentials', async t => {
  const { database } = localFiles(t);
  const store = new Store(database);
  let id: string;
  try {
    id = await readyToExport(store, new FakeMockupify());
  } finally {
    store.close();
  }
  for (const [index, operation] of mockupifyOperations.entries()) {
    const result = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', 'dist/src/cli.js', 'mockupify-writer-dispatch', id, operation,
    ], { env: { ...process.env, TEES4_DATABASE: database, TEES4_MOCKUPIFY_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const preview = JSON.parse(result.stdout);
    assert.equal(preview.method, 'POST');
    assert.equal(preview.request.path, ['/api/batches/', '/api/designs/', '/api/exports/'][index]);
    assert.equal(preview.claimState, index < 2 ? 'acknowledged' : null);
    assert.equal(preview.executionAuthorized, false);
    assert.match(preview.approvalDigest, /^[a-f0-9]{64}$/);
    if (operation === 'upload_design') {
      assert.deepEqual(preview.request.fields, { ...review.design, batch: 71, design_id: `tees4:${id}` });
      assert.equal(preview.request.file.sha256, input.png.preparedSha256);
    }
    if (operation === 'start_export') assert.deepEqual(preview.request.json, { batch: 71, colors: [11, 12] });
    assert.deepEqual(preview, await runMockupifyWriterCommand('mockupify-writer-preview', [id, operation], database));
  }
});

test('registration rejects malformed or mismatched metadata and wrong PNG bytes before any remote request', async t => {
  const { database, json, artwork } = localFiles(t);
  const { metadata, preparation } = pilotFixture();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected HTTP request'); });
  const auth = t.mock.method(GoogleAuth.prototype, 'getClient', async () => { throw new Error('Unexpected Google request'); });
  const preparationPath = json('preparation.json', preparation);
  const register = (value: unknown) => runMockupifyWriterCommand('mockupify-writer-register',
    [preparationPath, artwork, json('metadata review.json', value)], database);
  await assert.rejects(register({ ...metadata, publicationSafety: undefined }), { code: 'INVALID_INPUT' });
  await assert.rejects(register({ ...metadata, design: { ...metadata.design, extra_title: 'Wrong' } }),
    { code: 'MOCKUPIFY_PILOT_REVIEW_MISMATCH' });
  await assert.rejects(register(metadata), { code: 'MOCKUPIFY_PNG_EVIDENCE_MISMATCH' });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(auth.mock.callCount(), 0);
});

test('production CLI requires a separate unexpired approval, durable storage and a fresh source before one batch claim', async t => {
  const { directory, database, json, artwork: wrongPng } = localFiles(t);
  const fixture = pilotFixture();
  const { api, source, correlation, catalogColors, metadata, colors, artwork } = fixture;
  const id = correlation.correlationId;
  const template = api.catalog.find(product => product.id === mockupifyPilot.templateId)!;
  // Obtain the usual mapping fingerprint from the simulated preparation without the pilot artwork.
  // The on-disk production fixture is seeded with the approved digest. The actual pilot PNG is private.
  const store = new Store(database);
  try {
    const ordinary = new FakeMockupify();
    const { plan } = await ordinary.writer(store).prepare(input, review, png);
    store.registerMockupifyPlan({
      mode: 'production', source, review: metadata, catalogColors, artwork, colors,
      correlation: {
        ...plan.correlation, ...correlation, sourceRow: source.sourceRow, productSku: source.productSku,
        artworkSku: source.artworkSku, mockupifyTemplateId: template.id,
        mockupifyColorIds: colors.map(color => color.mockupifyColorId), preparedArtworkSha256: artwork.preparedSha256,
      },
    });
  } finally {
    store.close();
  }

  for (const [key, value] of Object.entries({
    TEES4_MOCKUPIFY_API_KEY: 'synthetic-mockupify-token',
    TEES4_SHOPIFY_DOMAIN: metadata.shop.domain,
    TEES4_SHOPIFY_SHOP_ID: metadata.shop.id,
    TEES4_SHOPIFY_CLIENT_ID: 'synthetic-client',
    TEES4_SHOPIFY_CLIENT_SECRET: 'synthetic-secret',
  })) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
  t.mock.method(ShopifyReadonlyClient.prototype, 'verifyShop', async () => metadata.shop);
  const fetch = t.mock.method(globalThis, 'fetch', async (target: URL, init: RequestInit) => {
    assert.equal(target.origin, 'https://mockupify.io');
    const mockUrl = new URL(target.pathname + target.search, 'https://mockupify.invalid');
    if (init.method === 'POST') {
      assert.equal(target.pathname, '/api/batches/');
      assert.deepEqual(JSON.parse(init.body as string), { name: correlation.batchName });
      const observed = new Store(database, { readOnly: true });
      try {
        assert.equal(observed.getMockupifyJournal(id).claims.create_batch?.state, 'dispatching');
      } finally {
        observed.close();
      }
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer mockupify-simulation');
    return api.fetch(mockUrl, { ...init, headers });
  });
  const headers = ['Artwork Name(From Google Drive)', 'Product Title', 'Product Description', 'Vendor', 'Product',
    'Colors', 'Tags', 'Product SKU', 'Tees-4 Completed', '', 'Artwork SKU'];
  let currentDescription = 'Stale fixture description';
  const auth = t.mock.method(GoogleAuth.prototype, 'getClient', async () => ({
    request: async ({ url, method }: { url: string; method: string }) => {
      assert.equal(method, 'GET');
      assert.ok(decodeURIComponent(url).includes(`${masterInput.spreadsheetId}/values/'Master Input'!A1:K`));
      const cells = [source.sheetArtworkName, source.title, currentDescription, source.vendor, source.garment,
        source.rawColors, source.tags, source.productSku, '', '', source.artworkSku];
      return { data: { values: [headers, ...Array.from({ length: source.sourceRow - 2 }, () => []), cells] } };
    },
  }));

  function approval(operation: MockupifyOperation) {
    const reader = new Store(database, { readOnly: true });
    try {
      return { ...api.approve(reader, id, operation), expiresAt: Date.now() + 120_000 };
    } finally {
      reader.close();
    }
  }
  const batchApproval = approval('create_batch');
  const validPath = json('batch approval.json', batchApproval);
  const dispatch = (args: string[], execute = true) =>
    runMockupifyWriterCommand('mockupify-writer-dispatch', [id, ...args], database, { execute });
  await assert.rejects(dispatch(['create_batch', validPath], false), { code: 'CLI_USAGE' });
  await assert.rejects(dispatch(['create_batch']), { code: 'CLI_USAGE' });
  for (const invalid of [
    { ...batchApproval, digest: 'a'.repeat(64) },
    { ...batchApproval, expiresAt: Date.now() - 1 },
    { ...batchApproval, operation: 'upload_design' },
  ]) {
    await assert.rejects(dispatch(['create_batch', json('rejected.json', invalid)]), { code: 'MOCKUPIFY_APPROVAL_REQUIRED' });
  }
  await assert.rejects(dispatch(['create_batch', validPath]), { code: 'MOCKUPIFY_DURABLE_STORAGE_REQUIRED' });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(auth.mock.callCount(), 0);

  await runMockupifyWriterCommand('mockupify-durability-verify', [directory], database);
  await assert.rejects(dispatch(['create_batch', validPath]), { code: 'MOCKUPIFY_SOURCE_CHANGED' });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(auth.mock.callCount(), 1);
  currentDescription = source.description!;
  const result = await dispatch(['create_batch', validPath]);
  assert.ok(result && 'reconciliationRequired' in result);
  assert.equal(result.reconciliationRequired, false);
  assert.equal(result.journal.batchId, 71);
  await assert.rejects(dispatch(['create_batch', validPath]), { code: 'MOCKUPIFY_ALREADY_CLAIMED' });
  await assert.rejects(dispatch(['upload_design', validPath, wrongPng]), { code: 'MOCKUPIFY_APPROVAL_REQUIRED' });
  const uploadApproval = json('upload approval.json', approval('upload_design'));
  await assert.rejects(dispatch(['upload_design', uploadApproval, wrongPng]), { code: 'MOCKUPIFY_PNG_EVIDENCE_MISMATCH' });
  assert.deepEqual(api.posts, ['/api/batches/']);
  const inspected = await runMockupifyWriterCommand('mockupify-writer-inspect', [id], database);
  assert.ok(inspected && 'history' in inspected);
  assert.deepEqual(Object.keys(inspected.journal.claims), ['create_batch']);
});
