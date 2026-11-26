import { createHash } from 'node:crypto';
import { integer, object, onlyKeys, readJson, requiredText } from './config.js';
import { WorkerError } from './model.js';
import { fingerprintMockupifyMappings, parseMockupifyPlanningConfig, planMockupifyArtwork } from './mockupify-planning.js';
import type { MockupifyExportBindingDraft } from './mockupify-planning.js';
import { masterInput } from './sheets.js';

type PlanInputs = Parameters<typeof planMockupifyArtwork>[0];

const phase19Revision = 'phase-19-v1';
const phase19MappingFingerprint = '6dfd718603d1c2dd6c562338a412a05b4a484a4312359b7b23423a731bd82967';

const supplierStyles = new Map([
  ['Adult Shirt', '202'], ['Youth Shirt', '235'], ['Adult Sweatshirt', '320'], ['Youth Sweatshirt', '320Y'],
  ['Adult LongSleeve Shirt', '202LS'], ['Adult Tank Top', 'S105'], ["Women's Shirt", '213'],
]);

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new WorkerError('INVALID_INPUT', `Supply a SHA-256 digest for ${label}.`);
  }
  return value;
}

export function parseApprovedMockupifyConfig(input: unknown) {
  const data = object(input, 'Approved Mockupify configuration');
  onlyKeys(data, ['schemaVersion', 'revision', 'approval', 'observedBatch', 'mappings'], 'Approved Mockupify configuration');
  const config = parseMockupifyPlanningConfig({ observedBatch: data.observedBatch, mappings: data.mappings });
  const approval = object(data.approval, 'Mapping approval');
  onlyKeys(approval, ['source', 'scope', 'evidence', 'independentlyAuthenticated', 'fingerprint'], 'Mapping approval');
  const fingerprint = fingerprintMockupifyMappings(config.mappings);
  if (data.schemaVersion !== 1 || data.revision !== phase19Revision || fingerprint !== phase19MappingFingerprint || approval.source !== 'user_instruction' ||
    approval.scope !== 'exact_garment_template_mappings_only' || approval.independentlyAuthenticated !== false ||
    approval.fingerprint !== fingerprint) {
    throw new WorkerError('MOCKUPIFY_MAPPING_APPROVAL_MISMATCH', 'The mapping set, version or recorded approval does not match.');
  }
  return {
    config,
    revision: requiredText(data.revision, 'Mapping revision'),
    approval: {
      fingerprint,
      source: approval.source,
      scope: approval.scope,
      evidence: requiredText(approval.evidence, 'Approval evidence'),
      independentlyAuthenticated: false as const,
    },
  };
}

export function readApprovedMockupifyConfig() {
  return parseApprovedMockupifyConfig(readJson('config/mockupify-approved-v1.json', 'approved Mockupify mappings'));
}

export function parseMockupifyPreparationInput(input: unknown) {
  const data = object(input, 'Mockupify preparation input');
  onlyKeys(data, ['source', 'supplierColors', 'png'], 'Mockupify preparation input');
  const source = object(data.source, 'Master Input snapshot');
  onlyKeys(source, [
    'row', 'sheetArtworkName', 'title', 'artworkSku', 'productSku', 'garment', 'rawColors', 'completion', 'evidence',
  ], 'Master Input snapshot');
  if (source.completion !== null) {
    throw new WorkerError('MOCKUPIFY_SOURCE_COMPLETION', 'The preparation requires a blank Master Input completion cell.');
  }
  const garment = requiredText(source.garment, 'Master Input garment');
  const style = supplierStyles.get(garment);
  const rawColors = requiredText(source.rawColors, 'Master Input colors');
  const codes = rawColors.split(',').map(code => code.trim());
  if (!style || !codes.every(code => /^\d{2}$/.test(code)) || new Set(codes).size !== codes.length ||
    !Array.isArray(data.supplierColors) || data.supplierColors.length !== codes.length) {
    throw new WorkerError('MOCKUPIFY_SUPPLIER_COLORS', 'Supply one candidate lookup per distinct two-digit supplier code in source order.');
  }
  const colors = (data.supplierColors as unknown[]).map((entry, index) => {
    const item = object(entry, 'Supplier color evidence');
    onlyKeys(item, ['brand', 'style', 'code', 'name', 'mockupifyColorId', 'evidence'], 'Supplier color evidence');
    if (item.brand !== 'Tultex' || item.style !== style || item.code !== codes[index]) {
      throw new WorkerError('MOCKUPIFY_SUPPLIER_COLORS', 'The exact Tultex style and two-digit code must match the source row.');
    }
    return {
      brand: 'Tultex' as const, style, code: codes[index]!,
      name: requiredText(item.name, 'Supplier color name'),
      mockupifyColorId: integer(item.mockupifyColorId, 'Mockupify color ID', 1, Number.MAX_SAFE_INTEGER),
      evidence: requiredText(item.evidence, 'Supplier color evidence'),
    };
  });
  const png = object(data.png, 'PNG preparation evidence');
  onlyKeys(png, ['originalRef', 'originalSha256', 'preparedSha256'], 'PNG preparation evidence');
  return {
    source: {
      spreadsheetId: masterInput.spreadsheetId,
      sourceRow: integer(source.row, 'Physical Master Input row', 2, Number.MAX_SAFE_INTEGER),
      sheetArtworkName: requiredText(source.sheetArtworkName, 'Sheet artwork name'),
      title: requiredText(source.title, 'Proposed design title'),
      artworkSku: requiredText(source.artworkSku, 'Artwork SKU'),
      productSku: requiredText(source.productSku, 'Product SKU'),
      garment,
      rawColors,
      completion: null,
      evidence: requiredText(source.evidence, 'Master Input snapshot evidence'),
    },
    colors,
    png: {
      originalRef: requiredText(png.originalRef, 'Original artwork reference'),
      originalSha256: sha256(png.originalSha256, 'original PNG'),
      preparedSha256: sha256(png.preparedSha256, 'prepared PNG'),
    },
  };
}

export interface MockupifyPreparationRecord extends MockupifyExportBindingDraft {
  schemaVersion: 1;
  correlationId: string;
  state: 'dry_run';
  batchName: string;
  designReference: string;
  mappingFingerprint: string;
  planFingerprint: string;
  preparedArtworkSha256: string;
  supplierStyle: string;
  supplierColorCodes: string[];
}

export function mockupifyCorrelation(spreadsheetId: string, productSku: string) {
  const correlationId = digest(JSON.stringify([spreadsheetId, productSku]));
  return { correlationId, batchName: `tees4-${correlationId.slice(0, 32)}`, designReference: `tees4:${correlationId}` };
}

export function prepareMockupifyExport(
  approved: ReturnType<typeof parseApprovedMockupifyConfig>,
  input: ReturnType<typeof parseMockupifyPreparationInput>,
  pngBytes: Uint8Array,
  live: Pick<PlanInputs, 'catalog' | 'batches' | 'batchDesigns' | 'bindings'>,
  liveDesignReferences: readonly (string | null)[],
) {
  const { source, colors, png } = input;
  if (pngBytes.length < 8 || pngBytes.length > 1_500_000 ||
    !Buffer.from(pngBytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    digest(pngBytes) !== png.preparedSha256) {
    throw new WorkerError('MOCKUPIFY_PNG_EVIDENCE_MISMATCH', 'The local PNG must match the reviewed digest and fit within 1,500,000 bytes.');
  }
  if (source.title.length > 255) throw new WorkerError('MOCKUPIFY_TITLE_TOO_LONG', 'The design title must fit the documented 255-character limit.');
  const planned = planMockupifyArtwork({
    ...live, config: approved.config, approvedMappings: approved.config.mappings, artworkSku: source.artworkSku,
    sourceRows: [{ ...source, colors: colors.map(color => color.name).join(', ') }],
  });
  const row = planned.rows[0]!;
  if (planned.mappingValidation.some(mapping => mapping.status !== 'CATALOG_MATCH') || !row.bindingDraft ||
    colors.some((color, index) => color.name !== row.colors[index]?.requestedName || color.mockupifyColorId !== row.colors[index]?.colorId)) {
    throw new WorkerError('MOCKUPIFY_PREPARATION_BLOCKED', 'Verify every approved template, the exact proposed colors, and any active binding for this row.');
  }
  const { correlationId, batchName, designReference } = mockupifyCorrelation(source.spreadsheetId, source.productSku);
  if (live.batches.some(batch => batch.name === batchName) || liveDesignReferences.includes(designReference)) {
    throw new WorkerError('MOCKUPIFY_RECONCILIATION_REQUIRED', 'The planned batch name or design reference already exists. Reconcile the existing record before proceeding.');
  }
  const record: MockupifyPreparationRecord = {
    ...row.bindingDraft, schemaVersion: 1, correlationId, state: 'dry_run', batchName, designReference,
    mappingFingerprint: approved.approval.fingerprint,
    preparedArtworkSha256: png.preparedSha256,
    supplierStyle: colors[0]!.style,
    supplierColorCodes: colors.map(color => color.code),
    planFingerprint: digest(JSON.stringify({ input, approval: approved.approval.fingerprint })),
  };
  return {
    mode: 'dry_run', executionAuthorized: false,
    mappings: { revision: approved.revision, approval: approved.approval, catalog: planned.mappingValidation },
    source,
    colorReview: { status: 'pending_owner_review', items: colors },
    artworkReview: { status: 'pending_owner_review', ...png, bytes: pngBytes.length },
    observedBatch: planned.observedBatch,
    correlation: record,
    requestPreview: {
      createBatch: { method: 'POST', path: '/api/batches/', contentType: 'application/json', body: { name: batchName } },
      uploadDesign: {
        method: 'POST', path: '/api/designs/', contentType: 'multipart/form-data',
        fields: { batch: null, title: source.title, design_id: designReference, file: null },
        pendingValues: { batch: 'verified isolated batch ID', file: 'owner-reviewed PNG bound to the prepared SHA-256' },
      },
      export: {
        method: 'POST', path: '/api/exports/', contentType: 'application/json',
        body: { batch: null, colors: record.mockupifyColorIds },
        pendingValues: { batch: 'isolated batch verified to contain exactly the expected design ID' },
      },
    },
    pending: [
      'Review artwork bytes, designer attribution, color selections and resulting Shopify title, description, vendor, tags and visibility.',
      'Authorize supervised writes and recheck the live Master Input row, exact SKUs, registry, Shopify and catalog.',
      'Establish exclusive control of a new isolated batch for this Product SKU and recheck membership before export.',
      'Durably claim each operation before attempting it and resolve ambiguous results with read-only evidence.',
      'Enforce the America/Chicago protected window and the configured export safety margin.',
    ],
  };
}
