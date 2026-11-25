import { createHash } from 'node:crypto';
import { integer, object, onlyKeys, requiredText } from './config.js';
import type { mockupifyReadOnly } from './mockupify-readonly.js';
import { WorkerError } from './model.js';
import type { BindingAssignment, ProductBinding } from './product-bindings.js';
import { masterInput } from './sheets.js';

type Client = ReturnType<typeof mockupifyReadOnly>;
type Catalog = Awaited<ReturnType<Client['listProducts']>>;
type Batch = Awaited<ReturnType<Client['listBatches']>>[number];
type Design = Awaited<ReturnType<Client['listDesigns']>>[number];

interface CandidateMapping {
  garment: string;
  templateId: number;
  templateTitle: string;
  templateType: string;
}

export interface MockupifyPlanningConfig {
  observedBatch: { id: number; name: string };
  mappings: CandidateMapping[];
}

export interface MockupifySourceRow {
  sourceRow: number;
  productSku: string | null;
  artworkSku: string | null;
  garment: string | null;
  colors: string | null;
}

type RegistryBinding = Pick<ProductBinding, 'id' | 'status' | 'spreadsheetId' | 'rowNumber' | 'productSku'>;
type SourceIdentity = Pick<BindingAssignment, 'spreadsheetId' | 'productSku' | 'artworkSku'> & { sourceRow: number };

// A draft has no verified external IDs. It is separate from registered Shopify product bindings.
export interface MockupifyExportBindingDraft extends SourceIdentity {
  mockupifyBatchId: null;
  mockupifyDesignId: null;
  mockupifyTemplateId: number;
  mockupifyColorIds: number[];
  mockupifyExportId: null;
  shopifyShopGid: null;
  shopifyProductGid: null;
}

export type MockupifyExportBindingRecord = Omit<MockupifyExportBindingDraft,
  'mockupifyBatchId' | 'mockupifyDesignId' | 'mockupifyExportId' | 'shopifyShopGid' | 'shopifyProductGid'> & {
  mockupifyBatchId: number;
  mockupifyDesignId: number;
  mockupifyExportId: number;
  shopifyShopGid: string;
  shopifyProductGid: string;
};

export function parseMockupifyPlanningConfig(input: unknown): MockupifyPlanningConfig {
  const value = object(input, 'Mockupify planning configuration');
  onlyKeys(value, ['observedBatch', 'mappings'], 'Mockupify planning configuration');
  const batch = object(value.observedBatch, 'Observed batch');
  onlyKeys(batch, ['id', 'name'], 'Observed batch');
  if (!Array.isArray(value.mappings) || value.mappings.length === 0) {
    throw new WorkerError('INVALID_INPUT', 'Supply at least one explicit garment mapping.');
  }
  const garments = new Set<string>();
  const mappings = (value.mappings as unknown[]).map(entry => {
    const mapping = object(entry, 'Garment mapping');
    onlyKeys(mapping, ['garment', 'templateId', 'templateTitle', 'templateType'], 'Garment mapping');
    const garment = requiredText(mapping.garment, 'Master Input garment');
    if (garments.has(garment)) throw new WorkerError('DUPLICATE_GARMENT_MAPPING', 'Each garment may have only one explicit mapping.');
    garments.add(garment);
    return {
      garment,
      templateId: integer(mapping.templateId, 'Mockupify template ID', 1, Number.MAX_SAFE_INTEGER),
      templateTitle: requiredText(mapping.templateTitle, 'Expected Mockupify template title'),
      templateType: requiredText(mapping.templateType, 'Expected Mockupify template type'),
    };
  });
  return {
    observedBatch: {
      id: integer(batch.id, 'Observed batch ID', 1, Number.MAX_SAFE_INTEGER),
      name: requiredText(batch.name, 'Observed batch name'),
    },
    mappings,
  };
}

function validateMappings(mappings: CandidateMapping[], catalog: Catalog) {
  return mappings.map(mapping => {
    const matches = catalog.filter(template => template.id === mapping.templateId);
    const template = matches[0];
    if (matches.length > 1) return { mapping, status: 'AMBIGUOUS_TEMPLATE_ID' as const };
    if (!template) return { mapping, status: 'TEMPLATE_NOT_FOUND' as const };
    if (template.library || template.title !== mapping.templateTitle || template.type !== mapping.templateType) {
      return { mapping, status: 'TEMPLATE_MISMATCH' as const,
        observed: { title: template.title, type: template.type, library: template.library } };
    }
    return { mapping, status: 'CATALOG_MATCH' as const, colorCount: template.colors.length };
  });
}

function observeBatch(expected: MockupifyPlanningConfig['observedBatch'], batches: Batch[], designs: Design[]) {
  const matches = batches.filter(batch => batch.id === expected.id);
  const designIds = designs.map(design => design.id);
  const batch = matches[0];
  const status = !batch ? 'BATCH_NOT_FOUND'
    : matches.length !== 1 || batch.name !== expected.name || batch.designsCount !== designIds.length ||
      new Set(designIds).size !== designIds.length || designs.some(design => design.batchId !== batch.id)
      ? 'BATCH_MEMBERSHIP_UNVERIFIED'
      : designIds.length > 0 ? 'BATCH_CONTAINS_EXISTING_DESIGNS' : 'BATCH_EMPTY';
  return { id: expected.id, name: expected.name, status, designIds };
}

export function planMockupifyArtwork(input: {
  artworkSku: string;
  sourceRows: readonly MockupifySourceRow[];
  config: MockupifyPlanningConfig;
  catalog: Catalog;
  batches: Batch[];
  batchDesigns: Design[];
  bindings: readonly RegistryBinding[];
}) {
  const { artworkSku, sourceRows, config, catalog, batches, batchDesigns, bindings } = input;
  const mappingValidation = validateMappings(config.mappings, catalog);
  const validationByGarment = new Map(mappingValidation.map(result => [result.mapping.garment, result]));
  const canonicalMappings = [...config.mappings].sort((a, b) => a.garment < b.garment ? -1 : a.garment > b.garment ? 1 : 0);
  const mappingFingerprint = createHash('sha256').update(JSON.stringify(canonicalMappings)).digest('hex');

  const colorIds = new Map<number, number>();
  for (const template of catalog) {
    for (const color of template.colors) colorIds.set(color.id, (colorIds.get(color.id) ?? 0) + 1);
  }
  const skuCounts = new Map<string, number>();
  const rowCounts = new Map<number, number>();
  for (const row of sourceRows) {
    if (row.productSku !== null) skuCounts.set(row.productSku, (skuCounts.get(row.productSku) ?? 0) + 1);
    rowCounts.set(row.sourceRow, (rowCounts.get(row.sourceRow) ?? 0) + 1);
  }
  const activeBindings = bindings.filter(binding => binding.spreadsheetId === masterInput.spreadsheetId &&
    (binding.status === 'approved' || binding.status === 'proposed'));
  const selected = sourceRows.filter(row => row.artworkSku === artworkSku).sort((a, b) => a.sourceRow - b.sourceRow);
  if (selected.length === 0) throw new WorkerError('ARTWORK_NOT_FOUND', 'No physical Master Input rows match the exact Artwork SKU.');

  const rows = selected.map(row => {
    const issues: string[] = [];
    const matchingBindings = activeBindings.filter(binding =>
      binding.rowNumber === row.sourceRow || binding.productSku === row.productSku);
    if (matchingBindings.length) issues.push('ACTIVE_PRODUCT_BINDING');
    if (rowCounts.get(row.sourceRow)! > 1) issues.push('DUPLICATE_SOURCE_ROW');
    const productSku = row.productSku;
    if (productSku === null || !productSku.trim()) issues.push('MISSING_PRODUCT_SKU');
    else if (productSku !== productSku.trim() || !productSku.isWellFormed() || /\p{Cc}/u.test(productSku)) {
      issues.push('INVALID_PRODUCT_SKU');
    } else if (skuCounts.get(productSku)! > 1) issues.push('DUPLICATE_PRODUCT_SKU');

    const validation = row.garment === null ? undefined : validationByGarment.get(row.garment);
    if (!validation) issues.push('UNMAPPED_GARMENT');
    else if (validation.status !== 'CATALOG_MATCH') issues.push(validation.status);
    const template = validation?.status === 'CATALOG_MATCH'
      ? catalog.find(product => product.id === validation.mapping.templateId)! : null;
    // Preserve the source cell and keep tokens in order. Only delimiter padding is stripped.
    const tokens = (row.colors ?? '').split(',');
    const requested = tokens.map(name => name.trim());
    const nameCounts = new Map<string, number>();
    for (const name of requested) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    const colors = requested.map((name, index) => {
      const matches = name && template ? template.colors.filter(color => color.name === name) : [];
      const rawName = tokens[index]!;
      const literalMatches = rawName !== name ? template?.colors.filter(color => color.name === rawName) ?? [] : [];
      const candidateIds = [...matches, ...literalMatches].map(color => color.id);
      const id = matches[0]?.id;
      const colorIssues: string[] = [];
      if (!name) colorIssues.push('MISSING_COLOR_NAME');
      else if (/^\d+$/.test(name)) colorIssues.push('UNVERIFIED_COLOR_CODE');
      else if (!template) colorIssues.push('TEMPLATE_UNRESOLVED');
      else if (literalMatches.length || matches.length > 1) colorIssues.push('AMBIGUOUS_COLOR_NAME');
      else if (id === undefined) colorIssues.push('COLOR_NOT_FOUND');
      if (name && nameCounts.get(name)! > 1) colorIssues.push('DUPLICATE_REQUESTED_COLOR');
      if (candidateIds.some(colorId => colorIds.get(colorId) !== 1)) colorIssues.push('AMBIGUOUS_COLOR_ID');
      return { requestedName: name, colorId: colorIssues.length ? null : id!, candidateIds, issues: colorIssues };
    });
    if (template?.colors.some(color => {
      const parts = color.name.split(',').map(name => name.trim());
      return parts.length > 1 && requested.some((_, start) => parts.every((part, offset) => requested[start + offset] === part));
    })) issues.push('AMBIGUOUS_COLOR_DELIMITER');
    if (colors.length > 500) issues.push('TOO_MANY_COLORS');
    const bindingDraft: MockupifyExportBindingDraft | null =
      !issues.length && colors.every(color => color.issues.length === 0) && template && productSku !== null ? {
        spreadsheetId: masterInput.spreadsheetId,
        sourceRow: row.sourceRow,
        productSku,
        artworkSku,
        mockupifyBatchId: null,
        mockupifyDesignId: null,
        mockupifyTemplateId: template.id,
        mockupifyColorIds: colors.map(color => color.colorId!),
        mockupifyExportId: null,
        shopifyShopGid: null,
        shopifyProductGid: null,
      } : null;
    return {
      ...row,
      template: template && { id: template.id, title: template.title, type: template.type },
      colorsRequested: row.colors,
      colors,
      issues,
      activeBindingIds: matchingBindings.map(binding => binding.id),
      bindingDraft,
    };
  });

  const observedBatch = observeBatch(config.observedBatch, batches, batchDesigns);
  return {
    artworkSku,
    status: rows.some(row => !row.bindingDraft) || observedBatch.status !== 'BATCH_EMPTY' ? 'blocked' : 'owner_review_required',
    mappingApproval: { status: 'required', fingerprint: mappingFingerprint },
    mappingValidation,
    observedBatch,
    batchPolicy: {
      strategy: 'isolate_each_product_row',
      reuseObservedBatch: false,
      combinedBatchAllowed: false,
      expectedDesignsPerFutureBatch: 1,
    },
    rows,
  };
}
