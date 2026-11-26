import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readMasterInputMockupifyRows } from '../src/google-sheets.js';
import { parseMockupifyPlanningConfig, planMockupifyArtwork } from '../src/mockupify-planning.js';
import type { MockupifySourceRow } from '../src/mockupify-planning.js';
import { masterInput } from '../src/sheets.js';
import { Store } from '../src/store.js';

const configInput = {
  observedBatch: { id: 100, name: 'Fixture batch' },
  mappings: [
    { garment: 'Adult Shirt', templateId: 1, templateTitle: 'Fixture Tee', templateType: 'T-Shirt' },
    { garment: 'Adult Sweatshirt', templateId: 2, templateTitle: 'Fixture Hoodie', templateType: 'Hoodie' },
  ],
};
const config = parseMockupifyPlanningConfig(configInput);
const color = (id: number, name: string) => ({ id, name, price: '5.00', sizes: ['M'] });
const tee = { id: 1, title: 'Fixture Tee', type: 'T-Shirt', library: false, colors: [color(11, 'White'), color(12, 'Black')] };
const hoodie = { id: 2, title: 'Fixture Hoodie', type: 'Hoodie', library: false, colors: [color(21, 'White'), color(22, 'Black')] };
const shirtRow = { sourceRow: 9, artworkSku: '00042', productSku: '000710', garment: 'Adult Shirt', colors: 'White, Black' };
const hoodieRow = { sourceRow: 16, artworkSku: '00042', productSku: '000711', garment: 'Adult Sweatshirt', colors: 'Black' };
const batch = { ...config.observedBatch, designsCount: 0 };
const design = { id: 90, title: 'Other design', batchId: 100, batchName: batch.name, designReference: null, created: '2026-01-01T00:00:00Z' };

function preview(rows: MockupifySourceRow[], overrides: Partial<Parameters<typeof planMockupifyArtwork>[0]> = {}) {
  return planMockupifyArtwork({
    artworkSku: '00042', sourceRows: rows, config, approvedMappings: config.mappings, catalog: [tee, hoodie],
    batches: [batch], batchDesigns: [], bindings: [], ...overrides,
  });
}

test('exact colors resolve within each template and preserve physical rows and assigned SKUs', () => {
  const result = preview([hoodieRow, shirtRow, { ...shirtRow, sourceRow: 17, artworkSku: '42', productSku: '999' }]);
  assert.equal(result.status, 'owner_review_required');
  assert.equal(result.mappingApproval.status, 'required');
  assert.equal(result.observedBatch.status, 'BATCH_EMPTY');
  assert.deepEqual(result.rows.map(row => [
    row.sourceRow, row.artworkSku, row.productSku, row.template?.id, row.colorsRequested,
    row.colors.map(color => [color.requestedName, color.colorId]),
  ]), [
    [9, '00042', '000710', 1, 'White, Black', [['White', 11], ['Black', 12]]],
    [16, '00042', '000711', 2, 'Black', [['Black', 22]]],
  ]);
  assert.deepEqual(result.rows[0]?.bindingDraft, {
    spreadsheetId: masterInput.spreadsheetId, sourceRow: 9, artworkSku: '00042', productSku: '000710',
    mockupifyBatchId: null, mockupifyDesignId: null, mockupifyTemplateId: 1, mockupifyColorIds: [11, 12],
    mockupifyExportId: null, shopifyShopGid: null, shopifyProductGid: null,
  });
  assert.deepEqual(result.rows[1]?.bindingDraft?.mockupifyColorIds, [22]);
  assert.equal(result.batchPolicy.combinedBatchAllowed, false);
  assert.equal(result.batchPolicy.expectedDesignsPerFutureBatch, 1);
});

test('missing, case-mismatched and similar colors block the row without changing requested labels', () => {
  const result = preview([{ ...shirtRow, colors: 'white, Off White, , Black, 04' }]);
  assert.equal(result.status, 'blocked');
  const row = result.rows[0]!;
  assert.equal(row.colorsRequested, 'white, Off White, , Black, 04');
  assert.deepEqual(row.colors.map(color => [color.colorId, color.issues]), [
    [null, ['COLOR_NOT_FOUND']], [null, ['COLOR_NOT_FOUND']], [null, ['MISSING_COLOR_NAME']],
    [12, []], [null, ['UNVERIFIED_COLOR_CODE']],
  ]);
  assert.equal(row.bindingDraft, null);
});

test('ambiguous catalog names, duplicate requested names and reused color IDs are flagged independently', () => {
  const result = preview([{ ...shirtRow, colors: 'White, White, Black' }], {
    catalog: [
      { ...tee, colors: [...tee.colors, color(31, 'White')] },
      { ...hoodie, colors: [...hoodie.colors, color(12, 'Extra Black')] },
    ],
  });
  const row = result.rows[0]!;
  assert.equal(row.bindingDraft, null);
  assert.deepEqual(row.colors.map(color => [color.candidateIds, color.colorId, color.issues]), [
    [[11, 31], null, ['AMBIGUOUS_COLOR_NAME', 'DUPLICATE_REQUESTED_COLOR']],
    [[11, 31], null, ['AMBIGUOUS_COLOR_NAME', 'DUPLICATE_REQUESTED_COLOR']],
    [[12], null, ['AMBIGUOUS_COLOR_ID']],
  ]);
});

test('color names that collide with delimiter padding or embedded commas require review', () => {
  const result = preview([shirtRow], {
    catalog: [{ ...tee, colors: [...tee.colors, color(31, ' Black'), color(32, 'White, Black')] }, hoodie],
  });
  assert.equal(result.rows[0]?.bindingDraft, null);
  assert.deepEqual(result.rows[0]?.issues, ['AMBIGUOUS_COLOR_DELIMITER']);
  assert.deepEqual(result.rows[0]?.colors[1]?.issues, ['AMBIGUOUS_COLOR_NAME']);
});

test('wrong, missing, duplicate and library template IDs cannot resolve', () => {
  for (const [catalog, code] of [
    [[{ ...hoodie, id: 1 }], 'TEMPLATE_MISMATCH'],
    [[{ ...tee, type: 'Hoodie' }], 'TEMPLATE_MISMATCH'],
    [[{ ...tee, library: true }], 'TEMPLATE_MISMATCH'],
    [[tee, tee], 'AMBIGUOUS_TEMPLATE_ID'],
    [[hoodie], 'TEMPLATE_NOT_FOUND'],
  ] as const) {
    const result = preview([shirtRow], { catalog: [...catalog] });
    assert.equal(result.mappingValidation[0]?.status, code);
    assert.deepEqual(result.rows[0]?.issues, [code]);
    assert.equal(result.rows[0]?.bindingDraft, null);
  }
  const numericCatalogName = preview([{ ...shirtRow, colors: '04' }], {
    catalog: [{ ...tee, colors: [color(14, '04')] }, hoodie],
  });
  assert.deepEqual(numericCatalogName.rows[0]?.colors[0], {
    requestedName: '04', candidateIds: [14], colorId: null, issues: ['UNVERIFIED_COLOR_CODE'],
  });
  const unmapped = preview([{ ...shirtRow, garment: 'Adult Tank Top' }]);
  assert.deepEqual(unmapped.rows[0]?.issues, ['UNMAPPED_GARMENT']);
});

test('owner review fingerprints are stable across mapping order and change when a mapping changes', () => {
  const original = preview([shirtRow]).mappingApproval.fingerprint;
  const reordered = parseMockupifyPlanningConfig({ ...configInput, mappings: [...configInput.mappings].reverse() });
  assert.equal(preview([shirtRow], { config: reordered }).mappingApproval.fingerprint, original);
  const changed = parseMockupifyPlanningConfig({
    ...configInput, mappings: [{ ...config.mappings[0], templateId: 99 }, config.mappings[1]],
  });
  assert.notEqual(preview([shirtRow], { config: changed }).mappingApproval.fingerprint, original);
  assert.throws(() => parseMockupifyPlanningConfig({
    ...configInput, mappings: [config.mappings[0], config.mappings[0]],
  }), { code: 'DUPLICATE_GARMENT_MAPPING' });
  assert.throws(() => parseMockupifyPlanningConfig({
    ...configInput, approval: { status: 'approved' },
  }), { code: 'INVALID_INPUT' });
});

test('planning blocks a non-library lookalike submitted under an approved garment', () => {
  const lookalike = { ...tee, id: 99 };
  const result = preview([shirtRow], {
    config: { ...config, mappings: [{ ...config.mappings[0]!, templateId: lookalike.id }] },
    catalog: [tee, lookalike],
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.mappingValidation[0]?.status, 'UNAPPROVED_TEMPLATE_MAPPING');
  assert.equal(result.rows[0]?.template, null);
  assert.equal(result.rows[0]?.bindingDraft, null);
});

test('an observed batch with unrelated designs cannot be reused or receive a combined color selection', () => {
  const result = preview([shirtRow, hoodieRow], {
    batches: [{ ...batch, designsCount: 1 }], batchDesigns: [design],
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.observedBatch.designIds, [90]);
  assert.equal(result.observedBatch.status, 'BATCH_CONTAINS_EXISTING_DESIGNS');
  assert.equal(result.batchPolicy.reuseObservedBatch, false);
  assert.equal(result.batchPolicy.combinedBatchAllowed, false);
  assert.ok(result.rows.every(row => row.bindingDraft?.mockupifyBatchId === null));
  assert.equal(preview([shirtRow], { batchDesigns: [design] }).observedBatch.status, 'BATCH_MEMBERSHIP_UNVERIFIED');
  assert.equal(preview([shirtRow], { batches: [] }).observedBatch.status, 'BATCH_NOT_FOUND');
});

test('repeated source rows and Product SKUs, including other artwork, block planning', () => {
  const result = preview([shirtRow, { ...shirtRow, artworkSku: 'other' }]);
  assert.deepEqual(result.rows[0]?.issues, ['DUPLICATE_SOURCE_ROW', 'DUPLICATE_PRODUCT_SKU']);
  assert.equal(result.rows[0]?.bindingDraft, null);
});

test('matching active registry bindings block by physical row or Product SKU', () => {
  const binding = { id: 'existing-match', spreadsheetId: masterInput.spreadsheetId, status: 'proposed' as const };
  const result = preview([shirtRow, hoodieRow], { bindings: [
    { ...binding, rowNumber: shirtRow.sourceRow, productSku: 'other' },
    { ...binding, id: 'existing-sku', rowNumber: 88, productSku: hoodieRow.productSku },
  ] });
  assert.deepEqual(result.rows.map(row => [row.issues, row.activeBindingIds]), [
    [['ACTIVE_PRODUCT_BINDING'], ['existing-match']], [['ACTIVE_PRODUCT_BINDING'], ['existing-sku']],
  ]);
  assert.ok(result.rows.every(row => row.bindingDraft === null));
  assert.ok(preview([shirtRow], { bindings: [
    { ...binding, status: 'stale', rowNumber: shirtRow.sourceRow, productSku: shirtRow.productSku },
  ] }).rows[0]?.bindingDraft);
});

test('the SQLite registry can be inspected in read-only mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mockupify-registry-'));
  try {
    const path = join(dir, 'worker.sqlite');
    new Store(path).close();
    const store = new Store(path, { readOnly: true });
    try {
      assert.deepEqual(store.listProductBindings(), []);
      const row = { rowNumber: 2, cells: Array<null>(11).fill(null) };
      assert.throws(() => store.importSheetFixtures([row]), /readonly/);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live planning intake reads formatted SKU strings and the exact garment and color cells', async () => {
  const result = await readMasterInputMockupifyRows(3, 'Product', async url => {
    assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
    assert.match(decodeURIComponent(url.pathname), /'Master Input'!E3:K$/);
    return { values: [
      ['Product', 'Colors', 'Tags', 'Product SKU', 'Tees-4 Completed', 'Category', 'Artwork SKU'],
      ['Adult Shirt', 'White, Black', '', '000710', '', '', '00042'],
      [],
      ['Adult Sweatshirt', '04,00', '', '000711', '', '', '00042'],
    ] };
  });
  assert.deepEqual(result, [
    { ...shirtRow, sourceRow: 4 },
    { sourceRow: 5, garment: null, colors: null, productSku: null, artworkSku: null },
    { ...hoodieRow, sourceRow: 6, colors: '04,00' },
  ]);
});
