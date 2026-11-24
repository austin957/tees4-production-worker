import { integer, object, onlyKeys, parseArtwork, parseArtworkIdentity, requiredText } from './config.js';
import { WorkerError } from './model.js';
import type { Artwork, GarmentAssignment, ProductionArtwork } from './model.js';

export const masterInput = {
  spreadsheetId: '1UxdIY03ICu5t2G0fEo0nor6-giAEF4xdMuNEvYN_JMM',
  spreadsheetName: 'Design Input Master',
  tab: 'Master Input',
} as const;

export interface GoogleSheetsAdapter {
  // Supply data rows with physical row numbers. Header discovery belongs in the adapter.
  readRows(source: typeof masterInput): Promise<readonly unknown[]>;
}

function cellText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.isWellFormed() || /\p{Cc}/u.test(value.replace(/[\n\r\t]/g, ''))) {
    throw new WorkerError('INVALID_SHEET_ROW', `${label} must contain text.`);
  }
  return value;
}

function parseRows(rows: readonly unknown[]) {
  const rowNumbers = new Set<number>();
  const productSkus = new Set<string>();
  const artworkNames = new Map<string, string>();
  return rows.map((entry, index) => {
    const row = object(entry, `Sheet data row ${index + 1}`);
    onlyKeys(row, ['rowNumber', 'cells'], 'Sheet data row');
    const n = integer(row.rowNumber, 'Sheet row number', 1, Number.MAX_SAFE_INTEGER);
    if (rowNumbers.has(n)) throw new WorkerError('DUPLICATE_SHEET_ROW', `Sheet row ${n} appears more than once.`);
    rowNumbers.add(n);
    if (!Array.isArray(row.cells) || row.cells.length !== 11) {
      throw new WorkerError('INVALID_SHEET_ROW', `Sheet row ${n} must contain positional cells A through K.`);
    }
    const [a, b, c, d, e, f, g, h, , , k] = row.cells as unknown[];
    const artworkSku = requiredText(k, `Sheet row ${n} K (Artwork SKU)`);
    const artworkName = requiredText(a, `Sheet row ${n} A (Artwork Name)`);
    const productSku = requiredText(h, `Sheet row ${n} H (Product SKU)`);
    if (productSkus.has(productSku)) {
      throw new WorkerError('DUPLICATE_PRODUCT_SKU', `Sheet row ${n} repeats a Product SKU.`);
    }
    productSkus.add(productSku);
    const existingName = artworkNames.get(artworkSku);
    if (existingName !== undefined && existingName !== artworkName) {
      throw new WorkerError('ARTWORK_NAME_CONFLICT', `Sheet row ${n} has a conflicting name for its Artwork SKU.`);
    }
    artworkNames.set(artworkSku, artworkName);
    const garment: GarmentAssignment = {
      sourceRow: n,
      productSku,
      productTitle: requiredText(b, `Sheet row ${n} B (Product Title)`),
      productDescription: cellText(c, `Sheet row ${n} C (Product Description)`),
      vendor: requiredText(d, `Sheet row ${n} D (Vendor)`),
      garmentSelection: requiredText(e, `Sheet row ${n} E (Garment Selection)`),
      colors: requiredText(f, `Sheet row ${n} F (Colors)`),
      tags: cellText(g, `Sheet row ${n} G (Tags)`),
    };
    return { artworkSku, artworkName, garment };
  }).sort((left, right) => left.garment.sourceRow - right.garment.sourceRow);
}

export async function readProductionArtwork(input: unknown, sheets: GoogleSheetsAdapter): Promise<ProductionArtwork> {
  const selection = object(input, 'Artwork selection');
  onlyKeys(selection, ['artworkId', 'artworkRef', 'designerId', 'artworkSku'], 'Artwork selection');
  const identity = parseArtworkIdentity(selection);
  const artworkSku = requiredText(selection.artworkSku, 'Artwork SKU');
  const rows = parseRows(await sheets.readRows(masterInput)).filter(row => row.artworkSku === artworkSku);
  const first = rows[0];
  if (!first) throw new WorkerError('ARTWORK_NOT_FOUND', 'No sheet rows match the selected Artwork SKU.');
  return {
    ...identity, kind: 'production', artworkSku, artworkName: first.artworkName, garments: rows.map(row => row.garment),
  };
}

export function parseJobArtwork(input: unknown): Artwork {
  const value = object(input, 'Artwork');
  if (value.kind !== 'production') return parseArtwork(input);
  onlyKeys(value, ['kind', 'artworkId', 'artworkRef', 'designerId', 'artworkSku', 'artworkName', 'garments'], 'Production artwork');
  if (!Array.isArray(value.garments) || value.garments.length === 0) {
    throw new WorkerError('INVALID_INPUT', 'Production artwork requires one or more garment assignments.');
  }
  const entries = value.garments.map(entry => {
    const garment = object(entry, 'Garment assignment');
    onlyKeys(garment, ['sourceRow', 'productSku', 'productTitle', 'productDescription', 'vendor', 'garmentSelection',
      'colors', 'tags'], 'Garment assignment');
    return {
      rowNumber: garment.sourceRow,
      cells: [value.artworkName, garment.productTitle, garment.productDescription, garment.vendor, garment.garmentSelection,
        garment.colors, garment.tags, garment.productSku, null, null, value.artworkSku],
    };
  });
  return {
    ...parseArtworkIdentity(value),
    kind: 'production',
    artworkSku: requiredText(value.artworkSku, 'Artwork SKU'),
    artworkName: requiredText(value.artworkName, 'Artwork Name'),
    garments: parseRows(entries).map(row => row.garment),
  };
}

export function simulatedSheets(rows: unknown): GoogleSheetsAdapter {
  if (!Array.isArray(rows)) throw new WorkerError('INVALID_SHEET_ROW', 'The sheet fixture must be a JSON array of data rows.');
  return { readRows: async () => rows };
}
