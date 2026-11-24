import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { googleSheets, parseSheetPolicy, previewSheetArtwork } from '../src/google-sheets.js';
import { masterInput } from '../src/sheets.js';

const headers = ['Artwork Name', 'Product Title', 'Product Description', 'Vendor', 'Product / garment selection',
  'Colors', 'Tags', 'Product SKU', '', '', 'Artwork SKU', 'Completion'];
const selection = { artworkId: 'art-1', artworkRef: 'fixture://art/1', designerId: 'designer-1', artworkSku: '00017' };
const policy = parseSheetPolicy({ headerRow: 3, eligibility: { column: 'L', header: 'Completion', allowedValues: ['Approved'] } });

function row(productSku: unknown, artworkSku = selection.artworkSku, eligible: unknown = 'Approved'): unknown[] {
  return ['Art', 'Design tee', '', 'Vendor', 'Tee', 'Violet, White', '', productSku, '', '', artworkSku, eligible];
}

function preview(values: unknown[][]) {
  return previewSheetArtwork(selection, policy, googleSheets(policy, async () => ({ values })));
}

test('Sheets request preserves formatted SKUs, groups eligible garments, and keeps physical row numbers', async () => {
  const second = row('00b-009');
  second[4] = 'Hoodie';
  second[5] = 'Black';
  const values = [headers, row('00008'), [], ['Partial unrelated artwork'], row('pending', '00017', ''),
    row('unrelated', '00099'), second];
  let requests = 0;
  const result = await previewSheetArtwork(selection, policy, googleSheets(policy, async url => {
    requests += 1;
    assert.equal(url.origin, 'https://sheets.googleapis.com');
    assert.equal(decodeURIComponent(url.pathname), `/v4/spreadsheets/${masterInput.spreadsheetId}/values/'Master Input'!A3:L`);
    assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
    assert.equal(url.searchParams.get('majorDimension'), 'ROWS');
    return { values };
  }));
  assert.equal(requests, 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.artwork?.artworkSku, '00017');
  assert.equal(result.artwork?.artworkName, 'Art');
  assert.deepEqual(result.artwork?.garments.map(item => [item.sourceRow, item.productSku, item.garmentSelection, item.colors]), [
    [4, '00008', 'Tee', 'Violet, White'], [9, '00b-009', 'Hoodie', 'Black'],
  ]);
  assert.deepEqual(result.rows, [
    { rowNumber: 4, status: 'eligible' },
    { rowNumber: 7, status: 'ineligible', code: 'ELIGIBILITY_NOT_CONFIRMED' },
    { rowNumber: 9, status: 'eligible' },
  ]);
});

test('requires unique actual headers in mapped columns and accepts explicit label overrides', async () => {
  const renamed = [...headers];
  renamed[4] = 'Garment';
  await assert.rejects(preview([renamed]), { code: 'SHEET_HEADER_MISMATCH' });
  const repeated = [...headers];
  repeated[9] = 'Product SKU';
  await assert.rejects(preview([repeated]), { code: 'SHEET_HEADER_MISMATCH' });
  await assert.rejects(preview([]), { code: 'SHEET_HEADER_MISMATCH' });
  const configured = parseSheetPolicy({ ...policy, columnHeaders: { E: 'Garment' } });
  const result = await previewSheetArtwork(selection, configured, googleSheets(configured, async () => ({
    values: [renamed, row('00008')],
  })));
  assert.equal(result.status, 'ready');
});

test('distinguishes missing artwork from existing rows with no explicit approval', async () => {
  assert.equal((await preview([headers, [], ['partial'], row('x', '00018')])).status, 'artwork_not_found');
  const result = await preview([headers, row('x').slice(0, 11), row('y', '00017', 'Pending')]);
  assert.equal(result.status, 'no_eligible_rows');
  assert.equal(result.artwork, null);
  assert.ok(result.rows.every(row => row.status === 'ineligible'));
  assert.throws(() => parseSheetPolicy({
    ...policy, eligibility: { ...policy.eligibility, allowedValues: [''] },
  }), { code: 'INVALID_INPUT' });
  const checkbox = parseSheetPolicy({ ...policy, eligibility: { ...policy.eligibility, allowedValues: [true] } });
  const checked = await previewSheetArtwork(selection, checkbox, googleSheets(checkbox, async () => ({
    values: [headers, row('x', '00017', true), row('y', '00017', 'true')],
  })));
  assert.deepEqual(checked.artwork?.garments.map(item => item.productSku), ['x']);
});

test('returns row-level issues for approved incomplete rows without misclassifying unrelated rows', async () => {
  const missing = row('');
  const numeric = row(8);
  const result = await preview([headers, row('00008'), [], missing, numeric, ['unrelated']]);
  assert.equal(result.status, 'review_required');
  assert.deepEqual(result.artwork?.garments.map(garment => garment.productSku), ['00008']);
  assert.deepEqual(result.rows.map(item => [item.rowNumber, item.status, item.code]), [
    [4, 'eligible', undefined], [6, 'review_required', 'INVALID_INPUT'], [7, 'review_required', 'INVALID_INPUT'],
  ]);
});

test('blocks duplicate Product SKUs and conflicting artwork names for eligible selections', async () => {
  const duplicate = await preview([headers, row('00008'), row('00008', 'another', 'Pending')]);
  assert.equal(duplicate.status, 'review_required');
  assert.equal(duplicate.rows[0]?.code, 'DUPLICATE_PRODUCT_SKU');
  const conflict = row('00009');
  conflict[0] = 'Other artwork name';
  const conflicting = await preview([headers, row('00008'), conflict]);
  assert.equal(conflicting.status, 'review_required');
  assert.equal(conflicting.artwork, null);
  assert.ok(conflicting.rows.every(item => item.code === 'ARTWORK_NAME_CONFLICT'));
});

test('Google CLI refuses simulate mode before opening a database or loading credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'tees4-google-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'queue.sqlite');
  const result = spawnSync(process.execPath, ['dist/src/cli.js', 'submit-google-sheet', 'ignored', 'ignored', '--mode', 'simulate'], {
    encoding: 'utf8', env: { ...process.env, TEES4_DATABASE: database },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_USAGE/);
  assert.equal(existsSync(database), false);
});
