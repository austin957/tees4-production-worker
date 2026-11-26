import { object, integer, onlyKeys, readJson, requiredText } from './config.js';
import { mockupifyCorrelation, readApprovedMockupifyConfig } from './mockupify-preparation.js';
import { mockupifyOperations } from './mockupify-writer-model.js';
import type { MockupifyOperation } from './mockupify-writer-model.js';
import { previewMockupifyOperation, SupervisedMockupifyWriter } from './mockupify-writer.js';
import type { MockupifyRecoveryEvidence } from './mockupify-writer.js';
import { WorkerError } from './model.js';
import { masterInput } from './sheets.js';
import { ShopifyReadonlyClient, shopifyExportReadConfig } from './shopify-readonly.js';
import { Store } from './store.js';

export const mockupifyWriterCommands = {
  'mockupify-writer-dry-run': {},
  'mockupify-writer-inspect': {},
  'mockupify-writer-preview': {},
  'mockupify-writer-reconcile': {},
  'mockupify-writer-backup': {},
  'mockupify-durability-status': {},
  'mockupify-durability-verify': {},
} as const;

export function pilotMockupifyDryRun() {
  const approved = readApprovedMockupifyConfig();
  const template = approved.config.mappings.find(mapping => mapping.garment === 'Adult Tank Top')!;
  const productSku = '8419620257-S105';
  const correlation = mockupifyCorrelation(masterInput.spreadsheetId, productSku);
  return {
    mode: 'dry_run',
    evidence: 'Owner-supplied Master Input row 9 fixture',
    executionAuthorized: false,
    httpRequests: 0,
    journalClaims: 0,
    source: {
      spreadsheetId: masterInput.spreadsheetId, worksheet: masterInput.tab, row: 9,
      artworkSku: '8419620257', productSku, garment: template.garment,
      sheetArtworkName: 'SKU TEST', productTitle: 'Bold Arrow Emblem', artworkRegistryName: 'Bold Arrow Emblem',
      artworkNameDiscrepancy: 'preserved_source_name',
    },
    template: { ...template, review: 'owner_approved_mapping_only' },
    colors: [
      { name: 'Black', id: 20514, review: 'owner_approved' },
      { name: 'White', id: 20515, review: 'owner_approved' },
    ],
    correlation,
    trace: [
      { method: 'POST', path: '/api/batches/', body: { name: correlation.batchName }, status: 'blocked' },
      { method: 'POST', path: '/api/designs/', fields: { batch: null, design_id: correlation.designReference, file: null },
        status: 'blocked', pending: ['isolated batch ID', 'approved metadata and attribution', 'reviewed PNG digest'] },
      { method: 'GET', path: '/api/designs/?batch={id}', status: 'awaiting_batch_and_design' },
      { method: 'POST', path: '/api/exports/', body: { batch: null, colors: [20514, 20515] }, status: 'blocked' },
      { method: 'GET', path: '/api/exports/{id}/', status: 'awaiting_export' },
      { system: 'Shopify', status: 'awaiting_product_gid_and_shop_verification',
        expectedProductStatus: 'ACTIVE', expectedSalesChannelPublications: 0 },
    ],
    blockers: [
      'Verify the reviewed compressed PNG, exact design fields and expected Shopify metadata, prices and variants.',
      'Recheck the current physical Master Input row and SKU uniqueness with the worker credentials.',
      'Verify the Mockupify connection to the exact Shopify shop and exclusive batch control.',
      'Verify Shopify sales-channel read access and document the Hextom rule and safe interval for the entire test.',
      'Record separate operation-specific owner approvals and an export safety margin for a permitted time.',
      'Verify the existing SQLite database and backup location, then rehearse recovery and cutover for the journal and binding registry.',
    ],
    externalIds: { batchId: null, designId: null, exportId: null, shopifyProductGid: null },
  };
}

function recoveryEvidence(path: string): MockupifyRecoveryEvidence {
  const value = object(readJson(path, 'Recovery attestation'), 'Recovery attestation');
  onlyKeys(value, ['operation', 'remoteId', 'requestDigest', 'by', 'evidence', 'dispatcherStoppedEvidence', 'artworkSha256'], 'Recovery attestation');
  if (value.operation !== 'create_batch' && value.operation !== 'upload_design') {
    throw new WorkerError('MOCKUPIFY_OPERATION', 'Supply a batch or design recovery operation.');
  }
  return {
    operation: value.operation, remoteId: integer(value.remoteId, 'Observed remote ID', 1, Number.MAX_SAFE_INTEGER),
    requestDigest: requiredText(value.requestDigest, 'Recorded request digest'), by: requiredText(value.by, 'Attesting operator'),
    evidence: requiredText(value.evidence, 'Recovery evidence reference'),
    dispatcherStoppedEvidence: requiredText(value.dispatcherStoppedEvidence, 'Original dispatcher exit evidence'),
    ...(value.artworkSha256 === undefined ? {} : { artworkSha256: requiredText(value.artworkSha256, 'Verified artwork digest') }),
  };
}

export async function runMockupifyWriterCommand(command: string, args: string[], databasePath: string) {
  const [id, argument] = args;
  if (command === 'mockupify-writer-dry-run') {
    if (args.length) throw new WorkerError('CLI_USAGE', 'The dry-run command uses only the offline pilot fixture.');
    return pilotMockupifyDryRun();
  }
  if (command === 'mockupify-durability-status' || command === 'mockupify-durability-verify') {
    const verify = command === 'mockupify-durability-verify';
    if (args.length !== (verify ? 1 : 0) || (verify && !id)) {
      throw new WorkerError('CLI_USAGE', 'Run worker help for durability verification usage.');
    }
    const store = new Store(databasePath, verify ? { existing: true } : { readOnly: true });
    try {
      return verify ? await store.verifyMockupifyDurability(id!) : store.mockupifyDurabilityStatus();
    } finally {
      store.close();
    }
  }
  const validArity = command === 'mockupify-writer-preview' ? args.length === 2 :
    command === 'mockupify-writer-reconcile' ? args.length === 1 || args.length === 2 : args.length === 1;
  if (!validArity || !id) throw new WorkerError('CLI_USAGE', 'Wrong number of arguments. Run worker help for usage.');
  const store = new Store(databasePath, { readOnly: command !== 'mockupify-writer-reconcile' });
  try {
    switch (command) {
      case 'mockupify-writer-inspect': return store.inspectMockupifyJournal(id);
      case 'mockupify-writer-backup':
        await store.backupTo(id);
        return { backupPath: id, productionDurabilityVerified: false };
      case 'mockupify-writer-preview':
        if (!mockupifyOperations.includes(argument as MockupifyOperation)) {
          throw new WorkerError('MOCKUPIFY_OPERATION', 'Supply create_batch, upload_design or start_export.');
        }
        return { ...previewMockupifyOperation(store.getMockupifyJournal(id), argument as MockupifyOperation),
          executionAuthorized: false };
      case 'mockupify-writer-reconcile': {
        const writer = new SupervisedMockupifyWriter({
          store, env: process.env, shopify: new ShopifyReadonlyClient(shopifyExportReadConfig(process.env)),
        });
        return await writer.reconcile(id, argument ? recoveryEvidence(argument) : undefined);
      }
    }
  } finally {
    store.close();
  }
}
