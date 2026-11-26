import { object, integer, onlyKeys, readJson, requiredText } from './config.js';
import { assertMockupifyPng, mockupifyCorrelation, readApprovedMockupifyConfig, readMockupifyPng } from './mockupify-preparation.js';
import { assertMockupifyPilotPlan, assertMockupifyPilotReview, mockupifyPilot, parseMockupifyReview } from './mockupify-pilot.js';
import { mockupifyOperations } from './mockupify-writer-model.js';
import type { MockupifyApproval, MockupifyOperation } from './mockupify-writer-model.js';
import { previewMockupifyOperation, SupervisedMockupifyWriter } from './mockupify-writer.js';
import type { MockupifyRecoveryEvidence } from './mockupify-writer.js';
import { WorkerError } from './model.js';
import { masterInput } from './sheets.js';
import { ShopifyReadonlyClient, shopifyExportReadConfig } from './shopify-readonly.js';
import { Store } from './store.js';

export const mockupifyWriterCommands = {
  'mockupify-writer-dry-run': {},
  'mockupify-writer-register': {},
  'mockupify-writer-dispatch': { execute: { type: 'boolean' } },
  'mockupify-writer-inspect': {},
  'mockupify-writer-preview': {},
  'mockupify-writer-reconcile': {},
  'mockupify-writer-backup': {},
  'mockupify-durability-status': {},
  'mockupify-durability-verify': {},
} as const;

export function pilotMockupifyDryRun() {
  const approved = readApprovedMockupifyConfig();
  const pilot = mockupifyPilot;
  const template = approved.config.mappings.find(mapping => mapping.garment === pilot.garment)!;
  const { productSku, artworkSku, row } = pilot;
  const correlation = mockupifyCorrelation(masterInput.spreadsheetId, productSku);
  return {
    mode: 'dry_run',
    evidence: 'Owner-supplied Master Input row 9 fixture',
    executionAuthorized: false,
    httpRequests: 0,
    journalClaims: 0,
    source: {
      spreadsheetId: masterInput.spreadsheetId, worksheet: masterInput.tab, row,
      artworkSku, productSku, garment: template.garment,
      sheetArtworkName: pilot.sheetArtworkName, productTitle: pilot.title, artworkRegistryName: pilot.title,
      artworkNameDiscrepancy: 'preserved_source_name',
    },
    template: { ...template, review: 'owner_approved_mapping_only' },
    colors: pilot.colors.map(color => ({ ...color, review: 'owner_approved' })),
    correlation,
    trace: [
      { method: 'POST', path: '/api/batches/', body: { name: correlation.batchName }, status: 'blocked' },
      { method: 'POST', path: '/api/designs/', fields: { batch: null, design_id: correlation.designReference, file: null },
        status: 'blocked', pending: ['isolated batch ID', 'approved metadata and attribution', 'reviewed PNG digest'] },
      { method: 'GET', path: '/api/designs/?batch={id}', status: 'awaiting_batch_and_design' },
      { method: 'POST', path: '/api/exports/', body: { batch: null, colors: pilot.colors.map(color => color.id) }, status: 'blocked' },
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

function mockupifyOperation(value: unknown): MockupifyOperation {
  const operation = mockupifyOperations.find(candidate => candidate === value);
  if (!operation) throw new WorkerError('MOCKUPIFY_OPERATION', 'Supply create_batch, upload_design or start_export.');
  return operation;
}

function readApproval(path: string): MockupifyApproval {
  const value = object(readJson(path, 'Owner approval'), 'Owner approval');
  onlyKeys(value, ['operation', 'digest', 'by', 'evidence', 'expiresAt'], 'Owner approval');
  return {
    operation: mockupifyOperation(value.operation),
    digest: requiredText(value.digest, 'Operation approval digest'),
    by: requiredText(value.by, 'Approving owner'),
    evidence: requiredText(value.evidence, 'Owner approval evidence'),
    expiresAt: integer(value.expiresAt, 'Owner approval expiresAt', 1, Number.MAX_SAFE_INTEGER),
  };
}

function operationPreview(store: Store, id: string, operation: MockupifyOperation) {
  const journal = store.getMockupifyJournal(id);
  const claim = journal.claims[operation];
  const preview = previewMockupifyOperation(journal, operation);
  return {
    ...preview, method: 'POST',
    ...(claim ? { request: claim.request, requestDigest: claim.requestDigest, approvalDigest: claim.approval.digest } : {}),
    claimState: claim?.state ?? null, executionAuthorized: false,
  };
}

export async function runMockupifyWriterCommand(
  command: string, args: string[], databasePath: string,
  { execute = false, exportMarginMinutes }: { execute?: boolean; exportMarginMinutes?: number | undefined } = {},
) {
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
  const env = process.env;
  if (command === 'mockupify-writer-register') {
    if (args.length !== 3 || args.some(value => !value)) {
      throw new WorkerError('CLI_USAGE', 'Supply the preparation JSON, reviewed PNG and metadata-review JSON.');
    }
    const input = readJson(id!, 'Mockupify preparation');
    const png = readMockupifyPng(argument!);
    const review = parseMockupifyReview(readJson(args[2]!, 'Metadata review'));
    assertMockupifyPilotReview(review);
    assertMockupifyPng(png, mockupifyPilot.pngSha256);
    const store = new Store(databasePath);
    try {
      const writer = new SupervisedMockupifyWriter({
        store, env, mode: 'production', shopify: new ShopifyReadonlyClient(shopifyExportReadConfig(env)),
        validatePlan: assertMockupifyPilotPlan,
      });
      return await writer.prepare(input, review, png);
    } finally {
      store.close();
    }
  }
  if (command === 'mockupify-writer-dispatch' && execute) {
    const operation = mockupifyOperation(argument);
    const upload = operation === 'upload_design';
    if (args.length !== (upload ? 4 : 3) || args.some(value => !value)) {
      throw new WorkerError('CLI_USAGE', 'Execution requires one operation, its owner-approval JSON and, for upload_design only, the reviewed PNG.');
    }
    const approval = readApproval(args[2]!);
    const png = upload ? readMockupifyPng(args[3]!) : undefined;
    const store = new Store(databasePath, { existing: true });
    try {
      const writer = new SupervisedMockupifyWriter({
        store, env, mode: 'production', shopify: new ShopifyReadonlyClient(shopifyExportReadConfig(env)),
        ...(exportMarginMinutes === undefined ? {} : { exportMarginMinutes }),
        validatePlan: assertMockupifyPilotPlan,
      });
      const journal = await writer.dispatch(id!, operation, approval, png);
      return { journal, reconciliationRequired: journal.claims[operation]?.state === 'uncertain' };
    } finally {
      store.close();
    }
  }

  const preview = command === 'mockupify-writer-preview' || command === 'mockupify-writer-dispatch';
  const reconcile = command === 'mockupify-writer-reconcile';
  const validArity = preview ? args.length === 2 : reconcile ? args.length === 1 || args.length === 2 : args.length === 1;
  if (!validArity || !id) throw new WorkerError('CLI_USAGE', 'Wrong number of arguments. Run worker help for usage.');
  const store = new Store(databasePath, { readOnly: !reconcile, existing: reconcile });
  try {
    if (preview) return operationPreview(store, id, mockupifyOperation(argument));
    switch (command) {
      case 'mockupify-writer-inspect': return store.inspectMockupifyJournal(id);
      case 'mockupify-writer-backup':
        await store.backupTo(id);
        return { backupPath: id, productionDurabilityVerified: false };
      case 'mockupify-writer-reconcile': {
        const writer = new SupervisedMockupifyWriter({
          store, env, shopify: new ShopifyReadonlyClient(shopifyExportReadConfig(env)),
        });
        return await writer.reconcile(id, argument ? recoveryEvidence(argument) : undefined);
      }
    }
  } finally {
    store.close();
  }
}
