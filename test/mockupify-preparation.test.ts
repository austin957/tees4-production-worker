import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fingerprintMockupifyMappings } from '../src/mockupify-planning.js';
import { parseApprovedMockupifyConfig, parseMockupifyPreparationInput, prepareMockupifyExport } from '../src/mockupify-preparation.js';
import { Store } from '../src/store.js';

const configJson = JSON.parse(readFileSync('config/mockupify-approved-v1.json', 'utf8'));
const approved = parseApprovedMockupifyConfig(configJson);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ZkAAAAASUVORK5CYII=', 'base64');
const fixture = {
  source: {
    row: 9, sheetArtworkName: 'Fixture artwork', title: 'Fixture title', artworkSku: '000123',
    productSku: '000123-S105', garment: 'Adult Tank Top', rawColors: '50, 00', completion: null,
    evidence: 'fixture sheet row',
  },
  supplierColors: [
    { brand: 'Tultex', style: 'S105', code: '50', name: 'Black', mockupifyColorId: 11, evidence: 'fixture supplier record' },
    { brand: 'Tultex', style: 'S105', code: '00', name: 'White', mockupifyColorId: 12, evidence: 'fixture supplier record' },
  ],
  png: {
    originalRef: 'fixture original', originalSha256: '0'.repeat(64),
    preparedSha256: createHash('sha256').update(png).digest('hex'),
  },
};
const input = parseMockupifyPreparationInput(fixture);
const catalog = approved.config.mappings.map(mapping => ({
  id: mapping.templateId, title: mapping.templateTitle, type: mapping.templateType, library: false,
  colors: mapping.templateId === 10779 ? [
    { id: 11, name: 'Black', price: '5.00', sizes: ['M'] },
    { id: 12, name: 'White', price: '5.00', sizes: ['M'] },
  ] : [],
}));
const live = { catalog, batches: [{ id: 6100, name: 'Design Input', designsCount: 0 }], batchDesigns: [], bindings: [] };

test('the checked-in approval covers seven exact labels and changed sets cannot self-attest', () => {
  assert.equal(approved.config.mappings.length, 7);
  assert.ok(approved.config.mappings.some(mapping => mapping.garment === 'Adult LongSleeve Shirt'));
  assert.ok(!approved.config.mappings.some(mapping => mapping.garment === 'Adult Long Sleeve'));
  assert.equal(approved.approval.independentlyAuthenticated, false);
  const unsafe = structuredClone(configJson);
  unsafe.mappings[0].garment = 'Unsafe alias';
  unsafe.approval.fingerprint = fingerprintMockupifyMappings(unsafe.mappings);
  assert.throws(() => parseApprovedMockupifyConfig(unsafe), { code: 'MOCKUPIFY_MAPPING_APPROVAL_MISMATCH' });
  assert.throws(() => parseApprovedMockupifyConfig({
    ...configJson, approval: { ...configJson.approval, independentlyAuthenticated: true },
  }), { code: 'MOCKUPIFY_MAPPING_APPROVAL_MISMATCH' });
});

test('the dry-run preserves leading zeros and leaves every proposed write and external ID pending', () => {
  const result = prepareMockupifyExport(approved, input, png, live, []);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.source.artworkSku, '000123');
  assert.equal(result.source.productSku, '000123-S105');
  assert.deepEqual(result.correlation.supplierColorCodes, ['50', '00']);
  assert.equal(result.colorReview.status, 'pending_owner_review');
  assert.equal(result.artworkReview.status, 'pending_owner_review');
  assert.deepEqual(result.requestPreview.export.body, { batch: null, colors: [11, 12] });
  assert.equal(result.correlation.mockupifyDesignId, null);
  assert.equal(result.correlation.mockupifyExportId, null);
  assert.equal(result.correlation.shopifyProductGid, null);
  assert.equal(result.requestPreview.uploadDesign.fields.batch, null);
  assert.equal(result.requestPreview.uploadDesign.fields.file, null);
  assert.equal(result.requestPreview.createBatch.body.name, result.correlation.batchName);
  assert.ok(result.correlation.batchName.length <= 50);
});

test('wrong style, numeric coercion, and an already completed row are rejected', () => {
  for (const change of [{ style: '202' }, { code: 0 }, { code: '0' }]) {
    assert.throws(() => parseMockupifyPreparationInput({
      ...fixture, supplierColors: [fixture.supplierColors[0], { ...fixture.supplierColors[1], ...change }],
    }), { code: 'MOCKUPIFY_SUPPLIER_COLORS' });
  }
  assert.throws(() => parseMockupifyPreparationInput({
    ...fixture, source: { ...fixture.source, completion: 'Yes' },
  }), { code: 'MOCKUPIFY_SOURCE_COMPLETION' });
});

test('catalog drift, wrong color IDs and altered PNG bytes block preparation', () => {
  const drift = catalog.map(template => template.id === 10679 ? { ...template, title: 'Changed' } : template);
  assert.throws(() => prepareMockupifyExport(approved, input, png, { ...live, catalog: drift }, []),
    { code: 'MOCKUPIFY_PREPARATION_BLOCKED' });
  const wrongColor = parseMockupifyPreparationInput({
    ...fixture, supplierColors: [fixture.supplierColors[0], { ...fixture.supplierColors[1], mockupifyColorId: 11 }],
  });
  assert.throws(() => prepareMockupifyExport(approved, wrongColor, png, live, []),
    { code: 'MOCKUPIFY_PREPARATION_BLOCKED' });
  assert.throws(() => prepareMockupifyExport(approved, input, Buffer.concat([png, Buffer.of(0)]), live, []),
    { code: 'MOCKUPIFY_PNG_EVIDENCE_MISMATCH' });
});

test('an existing correlation marker requires reconciliation while the observed batch never becomes a target', () => {
  const first = prepareMockupifyExport(approved, input, png, live, []);
  assert.throws(() => prepareMockupifyExport(approved, input, png, live, [first.correlation.designReference]),
    { code: 'MOCKUPIFY_RECONCILIATION_REQUIRED' });
  assert.throws(() => prepareMockupifyExport(approved, input, png, {
    ...live, batches: [...live.batches, { id: 16, name: first.correlation.batchName, designsCount: 1 }],
  }, []), { code: 'MOCKUPIFY_RECONCILIATION_REQUIRED' });
  const withUnrelated = prepareMockupifyExport(approved, input, png, {
    ...live, batches: [{ ...live.batches[0]!, designsCount: 1 }],
    batchDesigns: [{ id: 20, batchId: 6100, batchName: 'Design Input', designReference: null, title: 'Other', created: '2026-01-01' }],
  }, []);
  assert.deepEqual(withUnrelated.observedBatch.designIds, [20]);
  assert.equal(withUnrelated.correlation.mockupifyBatchId, null);
  assert.equal(withUnrelated.requestPreview.export.body.batch, null);
});

test('the SQLite preparation reuses an identical record and refuses to replace a conflicting plan', () => {
  const record = prepareMockupifyExport(approved, input, png, live, []).correlation;
  const store = new Store(':memory:');
  try {
    assert.deepEqual(store.saveMockupifyPreparation(record, 1), { reused: false });
    assert.deepEqual(store.saveMockupifyPreparation(record, 2), { reused: true });
    assert.throws(() => store.saveMockupifyPreparation({ ...record, planFingerprint: 'f'.repeat(64) }, 3),
      { code: 'MOCKUPIFY_PREPARATION_CONFLICT' });
    assert.deepEqual(store.listProductBindings(), []);
  } finally {
    store.close();
  }
});
