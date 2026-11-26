import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { WorkerError } from './model.js';
import { readMasterInputSupervisedRows } from './google-sheets.js';
import {
  mockupifyOrigin, mockupifyReadOnly, mockupifyRetryDelay,
  parseBatch, parseDesignEvidence, parseExportDetail,
} from './mockupify-readonly.js';
import { parseApprovedMockupifyConfig, parseMockupifyPreparationInput, prepareMockupifyExport } from './mockupify-preparation.js';
import { mockupifyDigest, sha256 } from './mockupify-writer-model.js';
import type {
  MockupifyApproval, MockupifyClaim, MockupifyJournal, MockupifyOperation, MockupifyPost,
  MockupifyReview, SupervisedMockupifyPlan, SupervisedSourceRow,
} from './mockupify-writer-model.js';
import { assertExportWindow } from './production-schedule.js';
import { readStableShopifyProduct, shopifyGid } from './shopify-readonly.js';
import type { ProductRead, ShopifyReadonlyClient } from './shopify-readonly.js';
import { masterInput } from './sheets.js';
import type { Store } from './store.js';

const requestTimeout = 15_000;
const simulationOrigin = 'https://mockupify.invalid';
const simulationEnv = { TEES4_MOCKUPIFY_API_KEY: 'mockupify-simulation' };
const expectedEffects = {
  create_batch: 'Create one empty isolated Mockupify batch for this Product SKU.',
  upload_design: 'Upload one reviewed PNG and its exact design metadata into this isolated batch.',
  start_export: 'Create one Active Shopify product with the approved variants and zero sales-channel publications in the approved shop. No SKU assignment.',
} satisfies Record<MockupifyOperation, string>;
type Reader = ReturnType<typeof mockupifyReadOnly>;
type DesignEvidence = ReturnType<typeof parseDesignEvidence>;
type ExportEvidence = ReturnType<typeof parseExportDetail>;
type ShopifyReader = Pick<ShopifyReadonlyClient, 'verifyShop' | 'productForExport' | 'verifyExportPublicationAccess'>;
type SourceIdentity = Pick<SupervisedSourceRow, 'sourceRow' | 'productSku' | 'artworkSku' | 'garment'>;
export type MockupifyRecoveryEvidence = {
  operation: 'create_batch' | 'upload_design'; remoteId: number; requestDigest: string;
  by: string; evidence: string; dispatcherStoppedEvidence: string; artworkSha256?: string;
};

function stop(code: string, message: string): never {
  throw new WorkerError(code, message);
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function publicationSafety(plan: Pick<SupervisedMockupifyPlan, 'review'>) {
  const safety = plan.review.publicationSafety;
  if (!safety || !nonblank(safety.evidence) || !Number.isSafeInteger(safety.startsAt) ||
    !Number.isSafeInteger(safety.endsAt) || !Number.isSafeInteger(safety.minimumMinutes) ||
    safety.minimumMinutes < 1 || safety.endsAt - safety.startsAt <= safety.minimumMinutes * 60_000) return undefined;
  return safety;
}

function withinPublicationWindow(plan: SupervisedMockupifyPlan, now: number) {
  const safety = publicationSafety(plan);
  return !!safety && now >= safety.startsAt && now < safety.endsAt;
}

function assertReview(source: SupervisedSourceRow, review: MockupifyReview) {
  const { design, product, shop } = review;
  if (!nonblank(source.vendor) || design.vendor !== source.vendor || product.vendor !== source.vendor) {
    stop('MOCKUPIFY_VENDOR_MISMATCH', 'The design vendor and expected Shopify vendor must exactly match the nonblank Master Input Column D vendor.');
  }
  if (!nonblank(review.artworkRegistryName) || !nonblank(review.designerAttribution) ||
    (source.sheetArtworkName !== review.artworkRegistryName && !nonblank(review.artworkNameResolution)) ||
    !nonblank(review.exclusiveBatchControlEvidence)) {
    stop('MOCKUPIFY_REVIEW_REQUIRED', 'Record the reviewed artwork name, attribution, discrepancy resolution and exclusive batch control.');
  }
  if (!publicationSafety({ review })) {
    stop('MOCKUPIFY_PUBLICATION_SAFETY_REQUIRED', 'Record verified Hextom publication rule evidence and a window covering the entire pilot.');
  }
  const designKeys = ['description', 'extra_price', 'extra_title', 'search_tags', 'title', 'vendor'];
  const validDesign = isDeepStrictEqual(Object.keys(design).sort(), designKeys) &&
    Object.values(design).every(value => typeof value === 'string' && value.isWellFormed() &&
      value.length <= 255 && !value.includes('\u0000')) &&
    nonblank(design.title) && design.description.includes(review.designerAttribution) &&
    !design.search_tags.split(',').some(tag => tag.trim() === 'adjust') && /^-?\d{1,8}(?:\.\d{1,2})?$/.test(design.extra_price);
  if (!validDesign || !nonblank(product.title) || typeof product.descriptionHtml !== 'string' ||
    !product.descriptionHtml.includes(review.designerAttribution) ||
    product.status !== 'ACTIVE' || !Array.isArray(product.tags) || !product.tags.every(nonblank) ||
    product.tags.includes('adjust') || new Set(product.tags).size !== product.tags.length ||
    !Array.isArray(product.variants) || product.variants.length === 0 ||
    product.variants.some(variant => !/^\d+(?:\.\d{1,2})?$/.test(variant.price) ||
      !Object.keys(variant.options).length || Object.entries(variant.options).some(([name, value]) => !nonblank(name) || !nonblank(value))) ||
    new Set(product.variants.map(variant => mockupifyDigest(variant.options))).size !== product.variants.length) {
    stop('MOCKUPIFY_REVIEW_REQUIRED', 'Review all design fields, exact Active product metadata, prices, options and tags before dispatch.');
  }
  shopifyGid(shop.id, 'Shop');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(shop.domain) || !nonblank(shop.connectionEvidence)) {
    stop('MOCKUPIFY_REVIEW_REQUIRED', 'Record evidence independently linking the Mockupify account to the exact Shopify shop.');
  }
}

function approvedConfig() {
  return parseApprovedMockupifyConfig(JSON.parse(readFileSync('config/mockupify-approved-v1.json', 'utf8')) as unknown);
}

export function previewMockupifyOperation(journal: MockupifyJournal, operation: MockupifyOperation) {
  const { plan, batchId, designId } = journal;
  const { correlation } = plan;
  let request: MockupifyPost;
  switch (operation) {
    case 'create_batch':
      request = { operation, path: '/api/batches/', json: { name: correlation.batchName } };
      break;
    case 'upload_design':
      if (batchId === null) return stop('MOCKUPIFY_PREREQUISITE', 'Verify the isolated batch before approving an upload.');
      request = {
        operation, path: '/api/designs/',
        fields: { ...plan.review.design, batch: batchId, design_id: correlation.designReference },
        file: { name: 'review.png', type: 'image/png', sha256: correlation.preparedArtworkSha256 },
      };
      break;
    case 'start_export':
      if (batchId === null || designId === null) return stop('MOCKUPIFY_PREREQUISITE', 'Verify the batch and uploaded design before approving an export.');
      request = { operation, path: '/api/exports/', json: { batch: batchId, colors: correlation.mockupifyColorIds } };
      break;
    default: return stop('MOCKUPIFY_OPERATION', 'Unknown supervised Mockupify operation.');
  }
  const requestDigest = mockupifyDigest({ method: 'POST', request });
  const expectedSideEffects = expectedEffects[operation];
  const approvalDigest = mockupifyDigest({ plan, requestDigest, batchId, designId, expectedSideEffects });
  return { request, requestDigest, expectedSideEffects, approvalDigest };
}

function assertApproval(approval: MockupifyApproval | undefined, operation: MockupifyOperation, digest: string, now: number): asserts approval is MockupifyApproval {
  if (!approval || approval.operation !== operation || approval.digest !== digest || !nonblank(approval.by) ||
    !nonblank(approval.evidence) || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= now) {
    stop('MOCKUPIFY_APPROVAL_REQUIRED', 'Supply the unexpired explicit approval for this exact operation and scope.');
  }
}

function decimal(value: string): string {
  const [whole, cents = ''] = value.split('.');
  return `${whole!.replace(/^(-?)0+(?=\d)/, '$1')}.${cents.padEnd(2, '0')}`;
}

function assertDesign(design: DesignEvidence, plan: SupervisedMockupifyPlan, batchId: number, designId?: number) {
  const fields = plan.review.design;
  const defaults = { description: '', extra_title: '', search_tags: '', vendor: '', extra_price: '0.00' };
  const fieldsMatch = Object.keys(defaults).every(key => {
    const field = key as keyof typeof defaults;
    const actual = design[field] ?? defaults[field];
    return field === 'extra_price' ? decimal(actual) === decimal(fields[field]) : actual === fields[field];
  });
  if (design.batchId !== batchId || design.batchName !== plan.correlation.batchName ||
    design.designReference !== plan.correlation.designReference || design.title !== fields.title ||
    (designId !== undefined && design.id !== designId) || !fieldsMatch) {
    stop('MOCKUPIFY_DESIGN_MISMATCH', 'The Mockupify design does not match the isolated batch, reference, ID and approved metadata.');
  }
}

function checkProduct(product: ProductRead | null, gid: string, plan: SupervisedMockupifyPlan, createdAt: string): boolean {
  if (!product || product.id !== gid || product.status !== 'ACTIVE' || product.status !== plan.review.product.status ||
    product.publishedAt !== null || product.hasSalesChannelPublication !== false) return false;
  const expected = plan.review.product;
  const variants = product.variants.map(variant => {
    const entries = variant.selectedOptions.map(option => [option.name, option.value] as const);
    if (!variant.id || (variant.sku !== '' && variant.sku !== null) || !variant.price ||
      !/^\d+(?:\.\d{1,2})?$/.test(variant.price) || new Set(entries.map(([name]) => name)).size !== entries.length) return null;
    return mockupifyDigest({ options: Object.fromEntries(entries), price: decimal(variant.price) });
  }).sort();
  const expectedVariants = expected.variants.map(variant =>
    mockupifyDigest({ options: variant.options, price: decimal(variant.price) })).sort();
  return product.title === expected.title && product.descriptionHtml === expected.descriptionHtml &&
    product.vendor === expected.vendor && isDeepStrictEqual([...product.tags].sort(), [...expected.tags].sort()) &&
    new Set(product.variants.map(variant => variant.id)).size === product.variants.length &&
    isDeepStrictEqual(variants, expectedVariants) && Date.parse(product.createdAt) >= Date.parse(createdAt) - 1000;
}

function relatedProduct(entry: ExportEvidence['products'][number], journal: MockupifyJournal) {
  const { correlation } = journal.plan;
  return entry.design.id === journal.designId && entry.design.designReference === correlation.designReference &&
    entry.product.id === correlation.mockupifyTemplateId;
}

function sameColors(actual: number[], expected: number[]): boolean {
  return isDeepStrictEqual([...actual].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
}

export class SupervisedMockupifyWriter {
  private readonly mode: 'dry_run' | 'simulate' | 'production';
  private readonly reads: Reader;
  private readonly clock: () => number;
  private readonly transport: typeof fetch;
  private readonly origin: string;
  private readonly credential: string;

  constructor(private readonly options: {
    store: Store;
    env: NodeJS.ProcessEnv;
    shopify: ShopifyReader;
    readSource?: () => Promise<SupervisedSourceRow[]>;
    mode?: 'dry_run' | 'simulate' | 'production';
    simulationFetch?: typeof fetch;
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
    exportMarginMinutes?: number;
  }) {
    this.mode = options.mode ?? 'dry_run';
    this.clock = options.clock ?? Date.now;
    if (this.mode === 'simulate' && !options.simulationFetch) {
      stop('MOCKUPIFY_SIMULATION_REQUIRED', 'Inject a fake HTTP transport for supervised simulation.');
    }
    const simulated = this.mode === 'simulate';
    const env = simulated ? simulationEnv : options.env;
    this.transport = simulated ? options.simulationFetch! : fetch;
    this.origin = simulated ? simulationOrigin : mockupifyOrigin;
    // The GET client validates the credential before the writer can be used.
    this.credential = env.TEES4_MOCKUPIFY_API_KEY ?? '';
    this.reads = mockupifyReadOnly(env, async (input, init) => {
      options.store.reserveMockupifyRead(this.clock());
      const url = new URL(String(input));
      const response = await this.transport(new URL(url.pathname + url.search, this.origin), init);
      if (response.status === 429) this.recordRateLimit(response);
      return response;
    }, options.sleep);
  }

  private recordRateLimit(response: Response) {
    const now = this.clock();
    const delay = mockupifyRetryDelay(response.headers.get('Retry-After'), 0, now);
    this.options.store.deferMockupifyRequests(Math.min(Number.MAX_SAFE_INTEGER, now + delay));
  }

  private async verifyShop(plan: SupervisedMockupifyPlan) {
    const identity = await this.options.shopify.verifyShop();
    if (identity.id !== plan.review.shop.id || identity.domain !== plan.review.shop.domain) {
      stop('MOCKUPIFY_WRONG_SHOP', 'The Shopify shop does not match the approved GID and domain.');
    }
    return identity;
  }

  private async verifySource(expected: SourceIdentity) {
    const read = this.mode === 'production' ? readMasterInputSupervisedRows : this.options.readSource;
    const rows = (await read?.()) ?? [];
    const matches = rows.filter(row => row.productSku === expected.productSku);
    const source = matches[0];
    if (matches.length !== 1 || !source || !nonblank(expected.productSku) || !nonblank(expected.artworkSku) ||
      !nonblank(expected.garment) || !Number.isSafeInteger(expected.sourceRow) || expected.sourceRow < 2 ||
      source.sourceRow !== expected.sourceRow || source.artworkSku !== expected.artworkSku ||
      source.garment !== expected.garment || rows.filter(row => row.sourceRow === expected.sourceRow).length !== 1) {
      return stop('MOCKUPIFY_SOURCE_CHANGED', 'Verify a unique Product SKU, the Artwork SKU and garment on the selected physical Master Input row.');
    }
    return source;
  }

  async prepare(input: unknown, review: MockupifyReview, png: Uint8Array): Promise<MockupifyJournal> {
    if (this.mode === 'dry_run') stop('MOCKUPIFY_DRY_RUN', 'Dry-run mode does not register a dispatchable plan.');
    const prepared = parseMockupifyPreparationInput(input);
    const source = await this.verifySource(prepared.source);
    const { spreadsheetId: _spreadsheet, evidence: _evidence, ...expected } = prepared.source;
    if (!Object.entries(expected).every(([key, value]) => source[key as keyof SupervisedSourceRow] === value)) {
      stop('MOCKUPIFY_SOURCE_CHANGED', 'The supplied preparation does not match the current physical row.');
    }
    const reviewed = structuredClone(review);
    assertReview(source, reviewed);
    const approved = approvedConfig();
    const catalog = await this.reads.listProducts();
    const batches = await this.reads.listBatches();
    const designs = await this.reads.listDesigns();
    const report = prepareMockupifyExport(approved, prepared, png, {
      catalog, batches, batchDesigns: designs.filter(design => design.batchId === approved.config.observedBatch.id),
      bindings: this.options.store.listProductBindings(),
    }, designs.map(design => design.designReference));
    const template = catalog.find(entry => entry.id === report.correlation.mockupifyTemplateId)!;
    const selectedColors = prepared.colors.map(color => template.colors.find(entry => entry.id === color.mockupifyColorId)!);
    const plan = { mode: this.mode, correlation: report.correlation, source, review: reviewed,
      artwork: prepared.png, colors: prepared.colors, catalogColors: selectedColors };
    await this.verifyShop(plan);
    return this.options.store.registerMockupifyPlan(plan);
  }

  private async verifyPlanSource(plan: SupervisedMockupifyPlan) {
    const { correlation, source } = plan;
    if (correlation.spreadsheetId !== masterInput.spreadsheetId ||
      !isDeepStrictEqual(await this.verifySource({ ...correlation, garment: source.garment }), source)) {
      stop('MOCKUPIFY_SOURCE_CHANGED', 'The physical Master Input row or exact metadata changed after approval.');
    }
  }

  private async verifyCatalog(plan: SupervisedMockupifyPlan) {
    const approved = approvedConfig();
    const catalog = await this.reads.listProducts();
    const mapping = approved.config.mappings.find(entry => entry.garment === plan.source.garment);
    const template = catalog.filter(entry => entry.id === mapping?.templateId);
    if (!mapping || mapping.templateId !== plan.correlation.mockupifyTemplateId ||
      approved.approval.fingerprint !== plan.correlation.mappingFingerprint ||
      template.length !== 1 || template[0]!.title !== mapping.templateTitle || template[0]!.type !== mapping.templateType ||
      plan.catalogColors.some(approvedColor =>
        catalog.flatMap(entry => entry.colors).filter(color => color.id === approvedColor.id).length !== 1 ||
        !template[0]!.colors.some(color => isDeepStrictEqual(color, approvedColor)))) {
      stop('MOCKUPIFY_CATALOG_CHANGED', 'The live template or selected colors no longer match the approved plan.');
    }
    await this.verifyShop(plan);
  }

  private async confirmBatch(journal: MockupifyJournal, expectedCount: number): Promise<number> {
    const { batchId, plan } = journal;
    const batches = (await this.reads.listBatches()).filter(batch => batch.id === batchId || batch.name === plan.correlation.batchName);
    if (batchId === null || batchId === approvedConfig().config.observedBatch.id || batches.length !== 1 ||
      batches[0]!.name !== plan.correlation.batchName || batches[0]!.id !== batchId || batches[0]!.designsCount !== expectedCount) {
      return stop('MOCKUPIFY_BATCH_MEMBERSHIP', 'The isolated batch ID, name or design count could not be confirmed.');
    }
    const designs = await this.reads.listDesignEvidence(batchId);
    if (designs.length !== expectedCount) {
      stop('MOCKUPIFY_BATCH_MEMBERSHIP', 'The isolated batch has unexpected members.');
    }
    if (expectedCount === 1) assertDesign(designs[0]!, plan, batchId, journal.designId!);
    return batchId;
  }

  async dispatch(id: string, operation: MockupifyOperation, approval?: MockupifyApproval, png?: Uint8Array): Promise<MockupifyJournal> {
    if (this.mode === 'dry_run') stop('MOCKUPIFY_DRY_RUN', 'Dry-run mode bypasses all POST requests.');
    const journal = this.options.store.getMockupifyJournal(id);
    if (journal.claims[operation]) stop('MOCKUPIFY_ALREADY_CLAIMED', 'This operation already has a durable claim. Reconcile it using reads.');
    const { plan } = journal;
    const preview = previewMockupifyOperation(journal, operation);
    const reviewedApproval = structuredClone(approval);
    assertApproval(reviewedApproval, operation, preview.approvalDigest, this.clock());
    if (this.mode === 'production' && !this.options.store.hasVerifiedMockupifyDurability()) {
      stop('MOCKUPIFY_DURABLE_STORAGE_REQUIRED', 'Production requires verified durable journal and binding storage with tested restoration.');
    }
    if (plan.mode !== this.mode) stop('MOCKUPIFY_MODE_MISMATCH', 'The journal and dispatch mode must match.');
    assertReview(plan.source, plan.review);
    const checkWindow = () => {
      if (operation !== 'start_export') return;
      const now = this.clock();
      assertExportWindow(now, this.options.exportMarginMinutes);
      const safety = publicationSafety(plan);
      if (!safety || now < safety.startsAt || safety.endsAt - now <= safety.minimumMinutes * 60_000) {
        stop('MOCKUPIFY_PUBLICATION_WINDOW', 'The verified Hextom-safe window cannot cover the planned export and test.');
      }
    };
    checkWindow();
    const bytes = png && Buffer.from(png);
    if (operation === 'upload_design' && (!bytes || sha256(bytes) !== plan.correlation.preparedArtworkSha256)) {
      stop('MOCKUPIFY_PNG_EVIDENCE_MISMATCH', 'The upload bytes must match the reviewed PNG.');
    }
    await this.verifyPlanSource(plan);
    await this.verifyCatalog(plan);
    let remoteActive: number[] = [];
    if (operation === 'create_batch') {
      if ((await this.reads.listBatches()).some(batch => batch.name === plan.correlation.batchName) ||
        (await this.reads.listDesigns()).some(design => design.designReference === plan.correlation.designReference)) {
        stop('MOCKUPIFY_RECONCILIATION_REQUIRED', 'The correlation is already visible in Mockupify.');
      }
    } else if (operation === 'start_export') {
      await this.options.shopify.verifyExportPublicationAccess();
      const exports = await this.reads.listExports();
      if (exports.some(entry => entry.batch?.id === journal.batchId)) {
        stop('MOCKUPIFY_RECONCILIATION_REQUIRED', 'An export already exists for the isolated batch.');
      }
      remoteActive = exports.filter(entry => entry.status === 'generating_images' || entry.status === 'exporting')
        .map(entry => entry.id);
    }

    await this.verifyPlanSource(plan);
    if (operation !== 'create_batch') await this.confirmBatch(journal, operation === 'start_export' ? 1 : 0);
    const claim: MockupifyClaim = {
      request: preview.request, requestDigest: preview.requestDigest, approval: reviewedApproval,
      state: 'dispatching', claimedAt: this.clock(), designId: journal.designId,
    };
    const post = this.makePost(claim.request, bytes);
    const claimed = this.options.store.claimMockupifyOperation(journal, claim, remoteActive, () => {
      checkWindow();
      assertApproval(reviewedApproval, operation, preview.approvalDigest, this.clock());
    });
    let saved: MockupifyJournal;
    let exportAcknowledgment: ExportEvidence | undefined;
    try {
      checkWindow();
      assertApproval(reviewedApproval, operation, preview.approvalDigest, this.clock());
    } catch (error) {
      this.options.store.abortUnsentMockupifyOperation(claimed, journal.claims, claim, this.clock());
      throw error;
    }
    try {
      const response = await this.transport(new URL(claim.request.path, this.origin), post);
      if (response.status === 429) this.recordRateLimit(response);
      if (response.status !== (operation === 'start_export' ? 202 : 201)) {
        await response.body?.cancel();
        stop('MOCKUPIFY_POST_HTTP', `Mockupify returned HTTP ${response.status}. Reconcile the claim using reads.`);
      }
      const raw: unknown = await response.json();
      const outcome = { ...claimed };
      switch (operation) {
        case 'create_batch': {
          const batch = parseBatch(raw);
          if (batch.name !== plan.correlation.batchName || batch.designsCount !== 0 ||
            batch.id === approvedConfig().config.observedBatch.id) {
            stop('MOCKUPIFY_BATCH_MEMBERSHIP', 'The batch acknowledgment does not establish a new isolated batch.');
          }
          outcome.batchId = batch.id;
          break;
        }
        case 'upload_design': {
          const design = parseDesignEvidence(raw);
          assertDesign(design, plan, journal.batchId!);
          outcome.designId = design.id;
          break;
        }
        case 'start_export': {
          const detail = parseExportDetail(raw);
          if (detail.batch?.id !== journal.batchId || detail.batch?.name !== plan.correlation.batchName) {
            stop('MOCKUPIFY_EXPORT_MISMATCH', 'The export acknowledgment identifies an unexpected batch.');
          }
          exportAcknowledgment = detail;
          outcome.exportId = detail.id;
          outcome.observedProductGids = this.observedGids(detail);
          outcome.exportStatus = outcome.observedProductGids.length || detail.errors.length ||
            detail.status === 'finished' || detail.status === 'failed' ? 'held' : 'pending';
          break;
        }
      }
      saved = this.options.store.updateMockupifyJournal({
        ...outcome, claims: { ...claimed.claims, [operation]: { ...claim, state: 'acknowledged' } },
      }, { event: 'acknowledged', operation, at: this.clock(), ...this.remoteIds(outcome),
        ...(exportAcknowledgment ? { detail: exportAcknowledgment } : {}) });
    } catch (error) {
      const outcomeCode = error instanceof WorkerError ? error.code : 'MOCKUPIFY_POST_UNKNOWN';
      return this.options.store.updateMockupifyJournal({
        ...claimed, claims: { ...claimed.claims, [operation]: { ...claim, state: 'uncertain', outcomeCode } },
      }, { event: 'uncertain', operation, at: this.clock(), outcomeCode });
    }
    return saved;
  }

  private makePost(request: MockupifyPost, bytes: Buffer | undefined): RequestInit {
    const headers = new Headers({ Authorization: `Bearer ${this.credential}`, Accept: 'application/json' });
    let body: BodyInit;
    if ('json' in request) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(request.json);
    } else {
      // FormData serialization normalizes line endings in fields. Write the approved strings verbatim.
      const boundary = `tees4-${randomUUID()}`;
      const fields = Object.entries(request.fields);
      if (fields.some(([, value]) => String(value).includes(boundary)) || bytes!.includes(boundary)) {
        stop('MOCKUPIFY_MULTIPART_BOUNDARY', 'Could not encode the reviewed PNG and exact design fields.');
      }
      headers.set('Content-Type', `multipart/form-data; boundary=${boundary}`);
      const parts = fields.map(([key, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
      body = new Blob([
        ...parts,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${request.file.name}"\r\n` +
          `Content-Type: ${request.file.type}\r\n\r\n`,
        new Uint8Array(bytes!),
        `\r\n--${boundary}--\r\n`,
      ]);
    }
    return { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(requestTimeout) };
  }

  private remoteIds(journal: MockupifyJournal) {
    return { batchId: journal.batchId, designId: journal.designId, exportId: journal.exportId,
      shopifyProductGids: journal.observedProductGids };
  }

  private observedGids(detail: ExportEvidence): string[] {
    return [...new Set(detail.products.flatMap(entry => entry.shopifyProductGid ? [entry.shopifyProductGid] : []))];
  }

  async reconcile(id: string, proof?: MockupifyRecoveryEvidence): Promise<MockupifyJournal> {
    const journal = this.options.store.getMockupifyJournal(id);
    if (journal.plan.mode === 'simulate' && this.mode !== 'simulate') {
      stop('MOCKUPIFY_MODE_MISMATCH', 'Simulation evidence requires the same fake transport.');
    }
    const { claims, plan } = journal;
    const operation = claims.start_export ? 'start_export' : claims.upload_design ? 'upload_design' : 'create_batch';
    const claim = claims[operation];
    if (!claim) return journal;
    if (claim.state === 'dispatching' && this.clock() - claim.claimedAt < requestTimeout) {
      stop('MOCKUPIFY_DISPATCH_IN_FLIGHT', 'Wait for the original dispatch to settle before reconciliation.');
    }
    if (operation === 'start_export') return this.reconcileExport(journal, claim);
    if (claim.state === 'acknowledged' || claim.state === 'recovered') return journal;

    const recoveringBatch = operation === 'create_batch';
    const batches = (await this.reads.listBatches()).filter(batch => batch.name === plan.correlation.batchName);
    const batch = batches.length === 1 ? batches[0] : undefined;
    const designs = batch ? await this.reads.listDesignEvidence(batch.id) : [];
    let confirmedId: number | undefined;
    if (batch && batch.id !== approvedConfig().config.observedBatch.id) {
      if (recoveringBatch && batch.designsCount === 0 && designs.length === 0) confirmedId = batch.id;
      if (!recoveringBatch && batch.id === journal.batchId && batch.designsCount === 1 && designs.length === 1) {
        try {
          assertDesign(designs[0]!, plan, batch.id);
          confirmedId = designs[0]!.id;
        } catch (error) {
          if (!(error instanceof WorkerError)) throw error;
        }
      }
    }
    const attested = proof && proof.operation === operation && confirmedId !== undefined && proof.remoteId === confirmedId &&
      proof.requestDigest === claim.requestDigest && nonblank(proof.by) && nonblank(proof.evidence) &&
      nonblank(proof.dispatcherStoppedEvidence) && (recoveringBatch || proof.artworkSha256 === plan.correlation.preparedArtworkSha256);
    const update = {
      ...journal, ...(attested && recoveringBatch ? { batchId: confirmedId! } : {}),
      ...(attested && !recoveringBatch ? { designId: confirmedId! } : {}),
      claims: { ...claims, [operation]: { ...claim, state: attested ? 'recovered' as const : claim.state } },
    };
    return this.options.store.updateMockupifyJournal(update, {
      event: attested ? 'recovered' : 'recovery_candidates', operation, at: this.clock(), batches, designs,
      ...(attested ? { proof } : {}),
    });
  }

  private async reconcileExport(journal: MockupifyJournal, claim: MockupifyClaim) {
    let exportId = journal.exportId;
    if (exportId === null) {
      const candidates = (await this.reads.listExports()).filter(entry => entry.batch?.id === journal.batchId);
      if (candidates.length !== 1) {
        return this.options.store.updateMockupifyJournal({ ...journal, exportStatus: 'held' },
          { event: 'export_candidates', at: this.clock(), candidates });
      }
      exportId = candidates[0]!.id;
    }
    const detail = await this.reads.getExport(exportId);
    const related = detail.batch?.id === journal.batchId && detail.batch?.name === journal.plan.correlation.batchName &&
      Date.parse(detail.created) >= claim.claimedAt - 1000 && detail.products.length === 1 && relatedProduct(detail.products[0]!, journal);
    const entry = related ? detail.products[0]! : undefined;
    const selected = journal.plan.correlation.mockupifyColorIds;
    const subset = !!entry && entry.colorIds.length > 0 && new Set(entry.colorIds).size === entry.colorIds.length &&
      entry.colorIds.every(color => selected.includes(color));
    const authoritative = related && subset;
    const terminal = detail.status === 'finished' || detail.status === 'failed';
    const gids = [...new Set([...journal.observedProductGids, ...this.observedGids(detail)])];
    const observedAt = this.clock();
    const observed = this.options.store.updateMockupifyJournal({
      ...journal, exportId: authoritative ? exportId : journal.exportId,
      exportTerminal: journal.exportTerminal || (terminal && (authoritative || journal.exportId === exportId) &&
        detail.batch?.id === journal.batchId),
      exportStatus: !withinPublicationWindow(journal.plan, observedAt) || journal.publicationObserved ||
        terminal || gids.length || detail.errors.length ||
        (detail.products.length > 0 && !authoritative) || detail.batch?.id !== journal.batchId ? 'held' : 'pending',
      shopifyProductGid: null, observedProductGids: gids,
      claims: { ...journal.claims, start_export: authoritative && journal.exportId === null ? { ...claim, state: 'recovered' } : claim },
    }, { event: 'mockupify_export_read', at: observedAt, detail });

    // Numeric IDs are lookup candidates. They never substitute for a provider-returned Product GID.
    const lookups = [...new Set(detail.products.flatMap(row => row.shopifyProductGid ? [row.shopifyProductGid] :
      row.shopifyProductId ? [`gid://shopify/Product/${row.shopifyProductId}`] : []))];
    if (!lookups.length) return observed;
    const verified: { gid: string; metadataMatches: boolean; snapshot: ProductRead | null; issue?: string }[] = [];
    let shop;
    let publicationObserved = journal.publicationObserved ?? false;
    try {
      shop = await this.verifyShop(journal.plan);
      for (const gid of lookups) {
        try {
          const shopify = await readStableShopifyProduct({ product: async id => {
            const snapshot = await this.options.shopify.productForExport(id);
            publicationObserved ||= snapshot.hasSalesChannelPublication === true || snapshot.publishedAt !== null;
            return snapshot;
          } }, gid);
          verified.push({ gid, metadataMatches: checkProduct(shopify, gid, journal.plan, detail.created), snapshot: shopify });
        } catch (error) {
          publicationObserved ||= error instanceof WorkerError && error.code === 'SHOPIFY_PUBLICATION_CHANGED';
          verified.push({ gid, metadataMatches: false, snapshot: null,
            issue: error instanceof WorkerError ? error.code : 'SHOPIFY_READ_FAILED' });
        }
      }
      await this.verifyShop(journal.plan);
    } catch (error) {
      const event = { event: 'shopify_reconciliation_held', at: this.clock(),
        issue: error instanceof WorkerError ? error.code : 'SHOPIFY_READ_FAILED', publicationObserved };
      return publicationObserved ? this.options.store.holdMockupifyPublication(journal.plan.correlation.correlationId, event) :
        this.options.store.updateMockupifyJournal(observed, event);
    }
    const gid = entry?.shopifyProductGid;
    const now = this.clock();
    const withinWindow = withinPublicationWindow(journal.plan, now);
    const ready = withinWindow && !publicationObserved && authoritative && detail.status === 'finished' && detail.errors.length === 0 &&
      entry?.status === 'created' && sameColors(entry.colorIds, selected) && !!gid && gids.length === 1 &&
      verified.length === 1 && verified[0]!.gid === gid && verified[0]!.metadataMatches;
    const event = { event: 'shopify_reconciliation', at: now, shop, verified, withinPublicationWindow: withinWindow, publicationObserved, ready };
    if (publicationObserved) {
      return this.options.store.holdMockupifyPublication(journal.plan.correlation.correlationId, event);
    }
    return this.options.store.updateMockupifyJournal({
      ...observed, shopifyProductGid: ready ? gid : null,
      exportStatus: ready ? 'validated_for_binding_review' : 'held',
    }, event);
  }
}
