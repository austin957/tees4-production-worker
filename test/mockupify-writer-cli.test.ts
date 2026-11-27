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
    artworkSku: pilot.artworkSku, productSku: pilot.productSku, vendor: pilot.vendor, tags: 'Family, Grandpa',
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
  metadata.design.description = `${source.description}\r\nDesigned by Tees-4`;
  metadata.design.extra_title = '';
  metadata.design.vendor = metadata.product.vendor = pilot.vendor;
  metadata.design.search_tags = source.tags;
  metadata.product.title = `${pilot.title} ${pilot.garment}`;
  metadata.product.descriptionHtml = '<p>Synthetic description Tees-4</p>';
  metadata.product.tags = ['readytobuy', 'adult', 'S105', 'adjust', 'stock', 'Family', 'Grandpa'];
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

test('pending CLI accepts explicit unresolved values and reports operation blockers without modifying SQLite', async t => {
  const { database, json, artwork } = localFiles(t);
  const { metadata, preparation } = pilotFixture();
  const { initialDescriptionEvidence: _metadataEvidence, ...partialMetadata } = metadata;
  const draft = { ...partialMetadata, product: { ...metadata.product, descriptionHtml: null, title: null, variants: null },
    publicationSafety: null, exclusiveBatchControlEvidence: null };
  const files = [json('preparation.json', preparation), artwork, json('pending review.json', draft)];
  await assert.rejects(runMockupifyWriterCommand('mockupify-writer-register-pending', files, database),
    { code: 'MOCKUPIFY_PNG_EVIDENCE_MISMATCH' });
  await assert.rejects(runMockupifyWriterCommand('mockupify-writer-finalize', files, database), { code: 'INVALID_INPUT' });

  const store = new Store(database);
  try {
    const { initialDescriptionEvidence: _fixtureEvidence, ...partialReview } = review;
    const pending = await new FakeMockupify().writer(store).prepare(input, {
      ...partialReview, product: { ...review.product, descriptionHtml: null, title: null, variants: null },
      publicationSafety: null, exclusiveBatchControlEvidence: null,
    }, png, 'pending_review');
    const id = pending.plan.correlation.correlationId;
    const before = store.inspectMockupifyJournal(id);
    const result = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', 'dist/src/cli.js', 'mockupify-writer-readiness', id,
    ], { env: { ...process.env, TEES4_DATABASE: database, TEES4_MOCKUPIFY_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const readiness = JSON.parse(result.stdout);
    assert.equal(readiness.registrationState, 'pending_review');
    assert.equal(readiness.executionAuthorized, false);
    assert.deepEqual(readiness.missingReviewFields, [
      'product.descriptionHtml', 'initialDescriptionEvidence', 'publicationSafety', 'product.title', 'product.variants',
      'exclusiveBatchControlEvidence',
    ]);
    for (const operation of mockupifyOperations) {
      assert.ok(readiness.operations[operation].blockers.includes('VERIFY_EXCLUSIVE_BATCH_CONTROL'));
      assert.ok(readiness.operations[operation].requiredAtDispatch.includes('FRESH_OPERATION_SPECIFIC_OWNER_APPROVAL'));
    }
    assert.deepEqual(readiness.operations.create_batch.blockers, ['VERIFY_EXCLUSIVE_BATCH_CONTROL']);
    assert.ok(readiness.operations.start_export.blockers.includes('FINALIZE_EXPORT_REVIEW'));
    assert.ok(readiness.operations.upload_design.blockers.includes('VERIFY_ISOLATED_BATCH'));
    assert.ok(readiness.operations.start_export.blockers.includes('VERIFY_UPLOADED_DESIGN'));
    assert.ok(readiness.operations.start_export.blockers.includes('SUPPLY_HEXTOM_SAFE_INTERVAL'));
    assert.deepEqual(store.inspectMockupifyJournal(id), before);
  } finally {
    store.close();
  }
});

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

test('registration requires the exact combined Shopify tags while preserving the design tags', async t => {
  const { database, json, artwork } = localFiles(t);
  const { metadata, preparation } = pilotFixture();
  const preparePath = json('preparation.json', preparation);
  const register = (value: unknown) => runMockupifyWriterCommand('mockupify-writer-register',
    [preparePath, artwork, json('metadata review.json', value)], database);
  const { tags } = metadata.product;
  for (const invalid of [
    ['Family', 'Grandpa'],
    tags.filter(tag => tag !== 'adjust'),
    [...tags, 'unexpected'],
    [...tags, 'adjust'],
    tags.map(tag => tag === 'adjust' ? 'Adjust' : tag),
  ]) {
    await assert.rejects(register({ ...metadata, product: { ...metadata.product, tags: invalid } }),
      { code: 'MOCKUPIFY_PILOT_REVIEW_MISMATCH' });
  }
  await assert.rejects(register({ ...metadata, design: { ...metadata.design, search_tags: 'Family, Grandpa, adjust' } }),
    { code: 'MOCKUPIFY_PILOT_REVIEW_MISMATCH' });
  // Exact tags in any order pass review and reach the PNG gate.
  await assert.rejects(register({ ...metadata, product: { ...metadata.product, tags: [...tags].reverse() } }),
    { code: 'MOCKUPIFY_PNG_EVIDENCE_MISMATCH' });
});

test('production CLI stages a pilot and records export evidence against its acknowledged claims', async t => {
  const { directory, database, json, artwork } = localFiles(t);
  t.mock.property(mockupifyPilot, 'pngSha256', input.png.preparedSha256);
  const { api, source, correlation, metadata, preparation } = pilotFixture();
  api.expectedDesign = metadata.design;
  const id = correlation.correlationId;
  const wrongPng = join(directory, 'different.png');
  writeFileSync(wrongPng, Buffer.concat([png, Buffer.from([0])]));

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
      assert.ok(target.pathname === '/api/batches/' || target.pathname === '/api/designs/');
      const operation = target.pathname === '/api/batches/' ? 'create_batch' : 'upload_design';
      if (operation === 'create_batch') assert.deepEqual(JSON.parse(init.body as string), { name: correlation.batchName });
      const observed = new Store(database, { readOnly: true });
      try {
        assert.equal(observed.getMockupifyJournal(id).claims[operation]?.state, 'dispatching');
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
  let currentDescription = source.description;
  const auth = t.mock.method(GoogleAuth.prototype, 'getClient', async () => ({
    request: async ({ url, method }: { url: string; method: string }) => {
      assert.equal(method, 'GET');
      assert.ok(decodeURIComponent(url).includes(`${masterInput.spreadsheetId}/values/'Master Input'!A1:K`));
      const cells = [source.sheetArtworkName, source.title, currentDescription, source.vendor, source.garment,
        source.rawColors, source.tags, source.productSku, '', '', source.artworkSku];
      return { data: { values: [headers, ...Array.from({ length: source.sourceRow - 2 }, () => []), cells] } };
    },
  }));

  const preparationPath = json('preparation.json', preparation);
  const register = (command: string, value: unknown) => runMockupifyWriterCommand(command,
    [preparationPath, artwork, json('metadata review.json', value)], database);
  const { initialDescriptionEvidence: _metadataEvidence, ...partialMetadata } = metadata;
  const pending = await register('mockupify-writer-register-pending', {
    ...partialMetadata, product: { ...metadata.product, descriptionHtml: null, variants: null },
    exclusiveBatchControlEvidence: null, publicationSafety: null,
  });
  assert.ok(pending && 'registrationState' in pending);
  assert.equal(pending.registrationState, 'pending_review');
  const batchReview = (value: unknown) => runMockupifyWriterCommand('mockupify-writer-review-batch',
    [id, json('batch review.json', value)], database);
  await assert.rejects(batchReview({ exclusiveBatchControlEvidence: ' ' }), { code: 'INVALID_INPUT' });
  const staged = await batchReview({ exclusiveBatchControlEvidence: metadata.exclusiveBatchControlEvidence });
  assert.ok(staged && 'claims' in staged);
  assert.equal(staged.registrationState, 'pending_review');
  assert.equal(staged.plan.review.product.descriptionHtml, null);
  assert.deepEqual(staged.claims, {});
  assert.deepEqual(api.posts, []);
  currentDescription = 'Stale fixture description';
  fetch.mock.resetCalls();
  auth.mock.resetCalls();

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
  const readiness = await runMockupifyWriterCommand('mockupify-writer-readiness', [id], database);
  assert.ok(readiness && 'operations' in readiness);
  assert.equal(readiness.durability?.admitted, true);
  assert.deepEqual(readiness.operations.create_batch?.blockers, []);
  assert.deepEqual(readiness.operations.upload_design?.blockers, ['VERIFY_ISOLATED_BATCH']);
  assert.ok(readiness.operations.start_export?.blockers.includes('FINALIZE_EXPORT_REVIEW'));
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(auth.mock.callCount(), 0);
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

  await dispatch(['upload_design', uploadApproval, artwork]);
  const before = await runMockupifyWriterCommand('mockupify-writer-inspect', [id], database);
  assert.ok(before && 'history' in before);
  assert.equal(before.journal.registrationState, 'pending_review');
  assert.equal(before.journal.designId, 72);
  const now = Date.now();
  const evidence = {
    descriptionSourceEvidence: 'Synthetic blank template and reviewed upload evidence',
    variantOptionsEvidence: 'Synthetic Color and Size evidence',
    publicationSafety: { ...review.publicationSafety, startsAt: now, endsAt: now + 3_600_000 },
  };
  const record = (value: unknown) => runMockupifyWriterCommand('mockupify-writer-review-export',
    [id, json('export-review.json', value)], database);
  await assert.rejects(record({ ...evidence, publicationSafety: null }), { code: 'INVALID_INPUT' });
  const publication = t.mock.method(ShopifyReadonlyClient.prototype, 'verifyExportPublicationAccess', async () => {});
  Object.assign(api.designs[0]!, { description: 'Changed upstream' });
  await assert.rejects(record(evidence), { code: 'MOCKUPIFY_DESIGN_MISMATCH' });
  Object.assign(api.designs[0]!, { description: metadata.design.description });
  const exportedReview = await record(evidence);
  assert.equal(publication.mock.callCount(), 2);
  assert.ok(exportedReview && 'registrationState' in exportedReview && 'claims' in exportedReview);
  assert.equal(exportedReview.registrationState, 'finalized');
  assert.equal(exportedReview.plan.review.product.descriptionHtml, null);
  assert.deepEqual(exportedReview.plan.review.expectedInitialDescription, {
    source: 'uploaded_design_only', text: metadata.design.description, evidence: evidence.descriptionSourceEvidence,
  });
  assert.deepEqual(exportedReview.plan.review.product.variants, metadata.product.variants.map(variant => ({ ...variant, price: '18.99' })));
  assert.deepEqual(exportedReview.claims, before.journal.claims);
  assert.deepEqual([exportedReview.batchId, exportedReview.designId], [71, 72]);
  assert.deepEqual(api.posts, ['/api/batches/', '/api/designs/']);
  const after = await runMockupifyWriterCommand('mockupify-writer-inspect', [id], database);
  assert.ok(after && 'history' in after);
  assert.deepEqual(after.history.slice(0, -1), before.history);
});
