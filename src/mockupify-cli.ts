import { readFileSync, statSync } from 'node:fs';
import { integer, object, onlyKeys, readJson, requiredText } from './config.js';
import { readMasterInputMockupifyRows } from './google-sheets.js';
import { parseMockupifyPlanningConfig, planMockupifyArtwork } from './mockupify-planning.js';
import { parseApprovedMockupifyConfig, parseMockupifyPreparationInput, prepareMockupifyExport } from './mockupify-preparation.js';
import type { MockupifySourceRow } from './mockupify-planning.js';
import { Store } from './store.js';
import { mockupifyReadOnly } from './mockupify-readonly.js';
import { WorkerError } from './model.js';

export const mockupifyCommands = {
  'mockupify-auth': {},
  'mockupify-batches': {},
  'mockupify-designs': {},
  'mockupify-products': {},
  'mockupify-exports': {},
  'mockupify-export': {},
  'mockupify-prepare': { save: { type: 'boolean' } },
  'mockupify-plan': {
    'sheet-fixture': { type: 'string' },
    'header-row': { type: 'string' },
    'garment-header': { type: 'string' },
  },
} as const;

export async function runMockupifyCommand(command: Exclude<keyof typeof mockupifyCommands, 'mockupify-plan' | 'mockupify-prepare'>, args: string[]) {
  const id = args[0];
  const takesId = command === 'mockupify-designs' || command === 'mockupify-export';
  if (args.length > (takesId ? 1 : 0) || (command === 'mockupify-export' && id === undefined)) {
    throw new WorkerError('CLI_USAGE', 'Wrong number of arguments. Run worker help for usage.');
  }
  if (id !== undefined && !/^[1-9][0-9]*$/.test(id)) {
    throw new WorkerError('MOCKUPIFY_INVALID_ID', 'Supply a positive integer Mockupify ID.');
  }

  const client = mockupifyReadOnly();
  switch (command) {
    case 'mockupify-auth':
      await client.listBatches();
      return { authenticated: true };
    case 'mockupify-batches': return client.listBatches();
    case 'mockupify-designs': return client.listDesigns(id === undefined ? undefined : Number(id));
    case 'mockupify-products': return client.listProducts();
    case 'mockupify-exports': return client.listExports();
    case 'mockupify-export': return client.getExport(Number(id));
  }
}

function fixtureRows(path: string): MockupifySourceRow[] {
  const value = readJson(path, 'Mockupify sheet fixture');
  if (!Array.isArray(value)) throw new WorkerError('INVALID_INPUT', 'Supply an array of synthetic Master Input rows.');
  return (value as unknown[]).map(entry => {
    const row = object(entry, 'Mockupify fixture row');
    onlyKeys(row, ['sourceRow', 'garment', 'colors', 'productSku', 'artworkSku'], 'Mockupify fixture row');
    function cell(key: 'garment' | 'colors' | 'productSku' | 'artworkSku') {
      const value = row[key];
      if (value !== null && typeof value !== 'string') {
        throw new WorkerError('INVALID_INPUT', 'Fixture cells must be strings or null.');
      }
      return value;
    }
    return {
      sourceRow: integer(row.sourceRow, 'Physical Master Input row', 1, Number.MAX_SAFE_INTEGER),
      garment: cell('garment'), colors: cell('colors'), productSku: cell('productSku'), artworkSku: cell('artworkSku'),
    };
  });
}

export async function previewMockupifyPlan(args: string[], values: Record<string, unknown>, databasePath: string) {
  if (args.length !== 2) throw new WorkerError('CLI_USAGE', 'Supply the exact Artwork SKU and a Mockupify mapping file.');
  const artworkSku = requiredText(args[0], 'Artwork SKU');
  const config = parseMockupifyPlanningConfig(readJson(args[1]!, 'Mockupify planning configuration'));
  const fixture = values['sheet-fixture'];
  if (fixture !== undefined && (values['header-row'] !== undefined || values['garment-header'] !== undefined)) {
    throw new WorkerError('CLI_USAGE', 'Header options apply to live Master Input reads.');
  }
  const client = mockupifyReadOnly();
  const source = fixture === undefined ? 'live_master_input' : 'synthetic_fixture';
  const sourceRows = fixture === undefined
    ? await readMasterInputMockupifyRows(
      integer(Number(values['header-row'] ?? 1), 'Header row', 1, 1_000_000),
      requiredText(values['garment-header'] ?? 'Product', 'Master Input garment header'),
    )
    : fixtureRows(requiredText(fixture, 'Fixture path'));

  const [catalog, batches, batchDesigns] = await Promise.all([
    client.listProducts(), client.listBatches(), client.listDesigns(config.observedBatch.id),
  ]);
  const registryExists = statSync(databasePath, { throwIfNoEntry: false }) !== undefined;
  const registry = registryExists ? 'local_registry' : 'database_absent';
  const store = registryExists ? new Store(databasePath, { readOnly: true }) : null;
  try {
    const bindings = store?.listProductBindings() ?? [];
    return { source, registry, ...planMockupifyArtwork({
      artworkSku, sourceRows, config, catalog, batches, batchDesigns, bindings,
    }) };
  } finally {
    store?.close();
  }
}

export async function previewMockupifyPreparation(args: string[], save: boolean, databasePath: string) {
  if (args.length !== 3) throw new WorkerError('CLI_USAGE', 'Supply a preparation JSON, an approved mapping JSON and a local PNG.');
  const input = parseMockupifyPreparationInput(readJson(args[0]!, 'Mockupify preparation'));
  const approved = parseApprovedMockupifyConfig(readJson(args[1]!, 'approved Mockupify mappings'));
  let png: Buffer;
  try {
    const path = args[2]!;
    const info = statSync(path);
    if (!info.isFile() || info.size < 8 || info.size > 1_500_000) throw new Error('Invalid PNG size');
    png = readFileSync(path);
  } catch {
    throw new WorkerError('MOCKUPIFY_PNG_READ', 'Supply a readable local PNG within the documented size limit.');
  }
  const client = mockupifyReadOnly();
  const [catalog, batches, designs] = await Promise.all([
    client.listProducts(), client.listBatches(), client.listDesigns(),
  ]);
  const batchDesigns = designs.filter(design => design.batchId === approved.config.observedBatch.id);
  const registryExists = statSync(databasePath, { throwIfNoEntry: false }) !== undefined;
  const store = registryExists || save ? new Store(databasePath, { readOnly: !save }) : null;
  try {
    const report = prepareMockupifyExport(approved, input, png, {
      catalog, batches, batchDesigns, bindings: store?.listProductBindings() ?? [],
    }, designs.map(design => design.designReference));
    const localRecord = save ? store!.saveMockupifyPreparation(report.correlation, Date.now()) : null;
    return { ...report, registry: registryExists || save ? 'local_registry' : 'database_absent', localRecord };
  } finally {
    store?.close();
  }
}
