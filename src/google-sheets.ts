import { GoogleAuth } from 'google-auth-library';
import { integer, object, onlyKeys, requiredText } from './config.js';
import { WorkerError } from './model.js';
import { masterInput, parseArtworkSelection, productionArtworkFromRows } from './sheets.js';
import type { ProductionArtwork } from './model.js';
import type { GoogleSheetsAdapter } from './sheets.js';

export const sheetsReadOnlyScope = 'https://www.googleapis.com/auth/spreadsheets.readonly';

const mappedHeaders = {
  A: 'Artwork Name',
  B: 'Product Title',
  C: 'Product Description',
  D: 'Vendor',
  E: 'Product / garment selection',
  F: 'Colors',
  G: 'Tags',
  H: 'Product SKU',
  K: 'Artwork SKU',
};

function columnIndex(column: string): number {
  return [...column].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

export interface SheetEligibilityPolicy {
  headerRow: number;
  eligibility: { column: string; header: string; allowedValues: (string | boolean)[] };
  columnHeaders: typeof mappedHeaders;
}

export function parseSheetPolicy(input: unknown): SheetEligibilityPolicy {
  const raw = object(input, 'Sheet policy');
  onlyKeys(raw, ['headerRow', 'eligibility', 'columnHeaders'], 'Sheet policy');
  const eligibility = object(raw.eligibility, 'Eligibility policy');
  onlyKeys(eligibility, ['column', 'header', 'allowedValues'], 'Eligibility policy');
  const column = requiredText(eligibility.column, 'Eligibility column');
  if (!/^[A-Z]{1,3}$/.test(column) || Object.hasOwn(mappedHeaders, column)) {
    throw new WorkerError('INVALID_SHEET_POLICY', 'Choose a dedicated eligibility column outside the mapped production fields.');
  }
  const header = requiredText(eligibility.header, 'Eligibility header');
  if (!Array.isArray(eligibility.allowedValues) || eligibility.allowedValues.length === 0) {
    throw new WorkerError('INVALID_SHEET_POLICY', 'Supply one or more explicit eligible values.');
  }
  const allowedValues = eligibility.allowedValues.map((value: unknown) =>
    typeof value === 'boolean' ? value : requiredText(value, 'Eligible value'));
  const columnHeaders = { ...mappedHeaders };
  if (raw.columnHeaders !== undefined) {
    const overrides = object(raw.columnHeaders, 'Column header overrides');
    onlyKeys(overrides, Object.keys(mappedHeaders), 'Column header overrides');
    for (const key of Object.keys(mappedHeaders) as (keyof typeof mappedHeaders)[]) {
      if (Object.hasOwn(overrides, key)) columnHeaders[key] = requiredText(overrides[key], `Column ${key} header`);
    }
  }
  if (new Set([...Object.values(columnHeaders), header]).size !== Object.keys(columnHeaders).length + 1) {
    throw new WorkerError('INVALID_SHEET_POLICY', 'Mapped column headers and the eligibility header must be distinct.');
  }
  return { headerRow: integer(raw.headerRow, 'Header row', 1, 1_000_000), eligibility: { column, header, allowedValues }, columnHeaders };
}

type ReadValues = (url: URL) => Promise<unknown>;

function authenticatedReader(): ReadValues {
  const auth = new GoogleAuth({ scopes: [sheetsReadOnlyScope] });
  return async url => {
    let client;
    try {
      client = await auth.getClient();
    } catch {
      throw new WorkerError('GOOGLE_AUTH_UNAVAILABLE', 'Google Application Default Credentials could not be loaded.');
    }
    try {
      const response = await client.request({ url: url.toString(), method: 'GET', timeout: 15_000 });
      return response.data;
    } catch (error) {
      const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
      if (status === 401 || status === 403 || status === 404) {
        throw new WorkerError('GOOGLE_SHEETS_ACCESS', 'Sheets API access failed. Check the read-only scope, API enablement, spreadsheet sharing, and network access.');
      }
      throw new WorkerError('GOOGLE_SHEETS_READ', 'The Google Sheets values request failed.');
    }
  };
}

async function readSheetRows(
  source: typeof masterInput, start: string, end: string, headerRow: number,
  expectedHeaders: [string, string][], readValues: ReadValues,
) {
  const tab = `'${source.tab.replaceAll("'", "''")}'`;
  const range = `${tab}!${start}${headerRow}:${end}`;
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheetId)}/values/${encodeURIComponent(range)}`);
  // Keep the exact displayed SKU strings, including zeros supplied by a cell's number format.
  url.search = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' }).toString();
  const data = object(await readValues(url), 'Sheets values response');
  if (!Array.isArray(data.values) || !Array.isArray(data.values[0])) {
    throw new WorkerError('SHEET_HEADER_MISMATCH', 'The configured Master Input header row was not returned.');
  }
  const [header, ...rows] = data.values as unknown[];
  const headers = header as unknown[];
  for (const [column, expected] of expectedHeaders) {
    const index = columnIndex(column) - columnIndex(start);
    if (headers[index] !== expected || headers.filter(cell => cell === expected).length !== 1) {
      throw new WorkerError('SHEET_HEADER_MISMATCH', `Master Input column ${column} must contain the unique header "${expected}".`);
    }
  }
  return rows.map((cells, offset) => ({ rowNumber: headerRow + offset + 1, cells }));
}

export function googleSheets(policy: SheetEligibilityPolicy, readValues = authenticatedReader()): GoogleSheetsAdapter {
  return {
    readRows(source) {
      const end = columnIndex(policy.eligibility.column) > columnIndex('K') ? policy.eligibility.column : 'K';
      return readSheetRows(source, 'A', end, policy.headerRow,
        [...Object.entries(policy.columnHeaders), [policy.eligibility.column, policy.eligibility.header]], readValues);
    },
  };
}

export interface MasterInputSkuRow {
  rowNumber: number;
  productSku: string | null;
  artworkSku: string | null;
}

function displayedText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new WorkerError('INVALID_SHEET_ROW', 'Master Input text cells must be returned as exact displayed strings.');
  }
  return value;
}

async function readMasterInputSkuCells(headerRow: number, readValues: ReadValues, includeCompletion: boolean) {
  const headers: [string, string][] = [['H', mappedHeaders.H], ['K', mappedHeaders.K]];
  if (includeCompletion) headers.push(['I', 'Tees-4 Completed']);
  const rows = await readSheetRows(masterInput, 'H', 'K', headerRow, headers, readValues);
  return rows.map(({ rowNumber, cells }) => {
    if (!Array.isArray(cells)) throw new WorkerError('INVALID_SHEET_ROW', 'Sheets returned a data row with invalid cells.');
    return { row: { rowNumber, productSku: displayedText(cells[0]), artworkSku: displayedText(cells[3]) }, completion: cells[1] };
  });
}

export async function readMasterInputSkuRows(headerRow: number, readValues = authenticatedReader()): Promise<MasterInputSkuRow[]> {
  return (await readMasterInputSkuCells(headerRow, readValues, false)).map(({ row }) => row);
}

export interface MasterInputProductionRow extends MasterInputSkuRow {
  completion: string | null;
}

export async function readMasterInputProductionRows(headerRow: number, readValues = authenticatedReader()): Promise<MasterInputProductionRow[]> {
  const rows = await readMasterInputSkuCells(headerRow, readValues, true);
  return rows.map(({ row, completion }) => ({ ...row, completion: displayedText(completion) }));
}

export interface MasterInputMatchRow extends MasterInputSkuRow {
  title: string | null;
  vendor: string | null;
  garment: string | null;
  colors: string | null;
  tags: string | null;
  completion: string | null;
}

export async function readMasterInputMatchRows(headerRow: number, readValues = authenticatedReader()): Promise<MasterInputMatchRow[]> {
  const rows = await readSheetRows(masterInput, 'B', 'K', headerRow, [
    ['B', mappedHeaders.B], ['D', mappedHeaders.D], ['E', mappedHeaders.E], ['F', mappedHeaders.F],
    ['G', mappedHeaders.G], ['H', mappedHeaders.H], ['I', 'Tees-4 Completed'], ['K', mappedHeaders.K],
  ], readValues);
  return rows.flatMap(({ rowNumber, cells }) => {
    if (!Array.isArray(cells)) throw new WorkerError('INVALID_SHEET_ROW', 'Sheets returned a data row with invalid cells.');
    const row = {
      rowNumber, title: displayedText(cells[0]), vendor: displayedText(cells[2]), garment: displayedText(cells[3]),
      colors: displayedText(cells[4]), tags: displayedText(cells[5]), productSku: displayedText(cells[6]),
      completion: displayedText(cells[7]), artworkSku: displayedText(cells[9]),
    };
    return Object.values(row).some(value => typeof value === 'string') ? [row] : [];
  });
}

interface SheetPreview {
  status: 'ready' | 'review_required' | 'no_eligible_rows' | 'artwork_not_found';
  artworkSku: string;
  artwork: ProductionArtwork | null;
  rows: { rowNumber: number; status: 'eligible' | 'ineligible' | 'review_required'; code?: string; message?: string }[];
}

export async function previewSheetArtwork(input: unknown, policy: SheetEligibilityPolicy, sheets: GoogleSheetsAdapter): Promise<SheetPreview> {
  const selection = parseArtworkSelection(input);
  const { artworkSku } = selection;
  const rows = (await sheets.readRows(masterInput)).map(entry => {
    const row = object(entry, 'Sheet data row');
    if (!Array.isArray(row.cells)) throw new WorkerError('INVALID_SHEET_ROW', 'Sheets returned a data row with invalid cells.');
    return { rowNumber: integer(row.rowNumber, 'Sheet row number', 1, Number.MAX_SAFE_INTEGER), cells: row.cells as unknown[] };
  });
  const occurrences = new Map<string, number[]>();
  for (const row of rows) {
    const sku = row.cells[7];
    if (typeof sku !== 'string' || !sku) continue;
    const rowNumbers = occurrences.get(sku) ?? [];
    rowNumbers.push(row.rowNumber);
    occurrences.set(sku, rowNumbers);
  }

  const preview: SheetPreview = { status: 'artwork_not_found', artworkSku, artwork: null, rows: [] };
  const selected = rows.filter(row => row.cells[10] === artworkSku);
  if (!selected.length) return preview;
  const accepted: typeof rows = [];
  const eligibilityIndex = columnIndex(policy.eligibility.column);
  for (const row of selected) {
    const value = row.cells[eligibilityIndex];
    if ((typeof value !== 'string' && typeof value !== 'boolean')
      || !policy.eligibility.allowedValues.includes(value)) {
      preview.rows.push({ rowNumber: row.rowNumber, status: 'ineligible', code: 'ELIGIBILITY_NOT_CONFIRMED' });
      continue;
    }
    const cells = Array.from({ length: 11 }, (_, index) => row.cells[index] ?? '');
    try {
      const conflicts = typeof cells[7] === 'string' ? occurrences.get(cells[7]) : undefined;
      if (conflicts && conflicts.length > 1) {
        throw new WorkerError('DUPLICATE_PRODUCT_SKU', `The Product SKU also appears on another row (rows ${conflicts.join(', ')}).`);
      }
      productionArtworkFromRows(selection, [{ rowNumber: row.rowNumber, cells }]);
      accepted.push({ rowNumber: row.rowNumber, cells });
      preview.rows.push({ rowNumber: row.rowNumber, status: 'eligible' });
    } catch (error) {
      if (!(error instanceof WorkerError)) throw error;
      preview.rows.push({ rowNumber: row.rowNumber, status: 'review_required', code: error.code, message: error.message });
    }
  }
  if (accepted.length) {
    try {
      preview.artwork = productionArtworkFromRows(selection, accepted);
    } catch (error) {
      if (!(error instanceof WorkerError)) throw error;
      for (const row of preview.rows.filter(row => row.status === 'eligible')) {
        row.status = 'review_required';
        row.code = error.code;
        row.message = error.message;
      }
    }
  }
  preview.status = preview.rows.some(row => row.status === 'review_required') ? 'review_required'
    : preview.artwork ? 'ready' : 'no_eligible_rows';
  return preview;
}
