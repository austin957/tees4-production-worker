import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { integer, object, onlyKeys } from './config.js';
import type { GarmentCompletionTarget, SheetsCompletionAdapter } from './garment-completion.js';
import { parseExportEvidence } from './mockupify.js';
import type { ExportJob, ExportPlan } from './mockupify.js';
import { completionAction, isProduction, WorkerError } from './model.js';
import { assertExportWindow, assertSkuWindow, ProductionWriteDeferred } from './production-schedule.js';
import { existingSku, parseShopifyCatalog, resolveProduct } from './shopify-skus.js';
import type { InitialSkuTarget, ShopifyProduct, ShopifyProductBinding, ShopifySkuAdapter } from './shopify-skus.js';
import type { Artwork, Details, GarmentCompletion, Job, Mode, StageResult, Workflow, WriteAction } from './model.js';

export interface Claim {
  job: Job;
  token: string;
}

interface Effect {
  details: Details;
  reused: boolean;
}

function identity(artwork: Artwork, mode: Mode, workflow: Workflow): string {
  const completion = workflow.stages.some(stage => stage.kind === 'action' && stage.action === completionAction);
  return JSON.stringify(isProduction(artwork)
    ? [completion ? 'production-completion' : 'production', mode, artwork.artworkSku]
    : [mode, artwork.artworkId, artwork.sku]);
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          identity TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL,
          available_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          claim_token TEXT,
          lease_until INTEGER,
          body TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, available_at, created_at);
        CREATE TABLE IF NOT EXISTS mockupify_exports (
          id TEXT PRIMARY KEY,
          identity TEXT UNIQUE NOT NULL,
          export_ref TEXT UNIQUE,
          body TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mockupify_export_reservations (
          product_sku TEXT PRIMARY KEY,
          export_id TEXT NOT NULL REFERENCES mockupify_exports(id)
        );
        CREATE TABLE IF NOT EXISTS master_input_fixtures (
          row_number INTEGER PRIMARY KEY,
          cells TEXT NOT NULL,
          fixture TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS master_input_product_sku ON master_input_fixtures(json_extract(cells, '$[7]'));
        CREATE TABLE IF NOT EXISTS shopify_products (
          id TEXT PRIMARY KEY,
          artwork_sku TEXT NOT NULL,
          product_sku TEXT NOT NULL,
          fixture TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS shopify_product_bindings ON shopify_products(product_sku);
        CREATE TABLE IF NOT EXISTS shopify_variants (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES shopify_products(id),
          size TEXT NOT NULL,
          color TEXT NOT NULL,
          sku TEXT
        );
        CREATE INDEX IF NOT EXISTS shopify_variant_product ON shopify_variants(product_id);
        CREATE TABLE IF NOT EXISTS effects (
          key TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          request TEXT NOT NULL,
          details TEXT NOT NULL
        );
      `);
    } catch (error) {
      throw new WorkerError('DATABASE_OPEN', `Could not initialize the worker database: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private load(id: string): Job {
    const row = this.db.prepare('SELECT body FROM jobs WHERE id = ?').get(id);
    if (!row) throw new WorkerError('JOB_NOT_FOUND', 'No job matches that ID.');
    return JSON.parse(row.body as string) as Job;
  }

  get(id: string): Job {
    return this.load(id);
  }

  list(): Job[] {
    return this.db.prepare('SELECT body FROM jobs ORDER BY created_at, id').all()
      .map(row => JSON.parse(row.body as string) as Job);
  }

  submit(artwork: Artwork, workflow: Workflow, mode: Mode, now: number): { job: Job; duplicate: boolean } {
    return this.transaction(() => {
      const key = identity(artwork, mode, workflow);
      const row = this.db.prepare('SELECT body FROM jobs WHERE identity = ?').get(key);
      if (row) {
        const job = JSON.parse(row.body as string) as Job;
        if (JSON.stringify(job.artwork) !== JSON.stringify(artwork) || JSON.stringify(job.workflow) !== JSON.stringify(workflow)) {
          throw new WorkerError('JOB_CONFLICT', 'This artwork and SKU already have a job in this mode with different input or workflow.');
        }
        return { job, duplicate: true };
      }
      const job: Job = {
        id: randomUUID(), artwork, workflow, mode, status: 'queued', nextStage: 0, failures: 0,
        results: [], history: [{ at: now, event: 'submitted' }], createdAt: now, updatedAt: now, availableAt: now,
      };
      this.db.prepare('INSERT INTO jobs (id, identity, status, available_at, created_at, body) VALUES (?, ?, ?, ?, ?, ?)')
        .run(job.id, key, job.status, job.availableAt, job.createdAt, JSON.stringify(job));
      return { job, duplicate: false };
    });
  }

  private save(job: Job, now: number, token: string | null = null, lease: number | null = null): Job {
    job.updatedAt = now;
    this.db.prepare('UPDATE jobs SET status = ?, available_at = ?, claim_token = ?, lease_until = ?, body = ? WHERE id = ?')
      .run(job.status, job.availableAt, token, lease, JSON.stringify(job), job.id);
    return job;
  }

  claim(now: number): Claim | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT body FROM jobs
        WHERE (status IN ('queued', 'retry_wait') AND available_at <= ?)
           OR (status = 'running' AND lease_until <= ?)
        ORDER BY available_at, created_at, id LIMIT 1
      `).get(now, now);
      if (!row) return undefined;
      const job = JSON.parse(row.body as string) as Job;
      const stageId = job.workflow.stages[job.nextStage]!.id;
      if (job.status === 'running') job.history.push({ at: now, event: 'lease_recovered', stageId });
      job.status = 'running';
      job.history.push({ at: now, event: 'stage_started', stageId });
      const token = randomUUID();
      return { token, job: this.save(job, now, token, now + job.workflow.leaseMs) };
    });
  }

  private settle(claim: Claim, now: number, update: (job: Job) => void, keepLease = false): Job | undefined {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT body, lease_until FROM jobs WHERE id = ? AND claim_token = ? AND lease_until > ?')
        .get(claim.job.id, claim.token, now);
      if (!row) return undefined;
      const job = JSON.parse(row.body as string) as Job;
      update(job);
      return keepLease ? this.save(job, now, claim.token, row.lease_until as number) : this.save(job, now);
    });
  }

  checkpointGarment(claim: Claim, outcome: GarmentCompletion, now: number): boolean {
    return this.settle(claim, now, job => {
      job.garmentCompletions = [...(job.garmentCompletions ?? []).filter(row => row.sourceRow !== outcome.sourceRow), outcome]
        .sort((left, right) => left.sourceRow - right.sourceRow);
    }, true) !== undefined;
  }

  private advance(job: Job, result: StageResult, now: number): void {
    job.results.push(result);
    job.history.push({ at: now, event: result.outcome, stageId: result.stageId });
    job.nextStage += 1;
    job.failures = 0;
    job.availableAt = now;
    job.status = 'queued';
    if (job.nextStage === job.workflow.stages.length) {
      const needsReview = job.results.some(stage => stage.skuAssignments?.some(variant => variant.review))
        || job.garmentCompletions?.some(garment => garment.status === 'needs_review');
      job.status = needsReview ? 'needs_review' : 'completed';
      job.history.push({ at: now, event: job.status });
    }
  }

  finish(claim: Claim, result: StageResult, now: number): Job | undefined {
    return this.settle(claim, now, job => this.advance(job, result, now));
  }

  pause(claim: Claim, stageId: string, now: number): Job | undefined {
    return this.settle(claim, now, job => {
      job.status = 'awaiting_approval';
      job.history.push({ at: now, event: 'approval_required', stageId });
    });
  }

  approve(id: string, stageId: string, approver: string, now: number): Job {
    return this.transaction(() => {
      const job = this.load(id);
      if (job.results.some(result => result.stageId === stageId && result.outcome === 'approved')) return job;
      const stage = job.workflow.stages[job.nextStage];
      if (job.status !== 'awaiting_approval' || stage?.kind !== 'approval' || stage.id !== stageId) {
        throw new WorkerError('APPROVAL_MISMATCH', 'This job is not awaiting approval for that stage.');
      }
      this.advance(job, { stageId, outcome: 'approved', details: { approver } }, now);
      return this.save(job, now);
    });
  }

  defer(claim: Claim, stageId: string, error: WorkerError, retryAt: number, now: number): Job | undefined {
    return this.settle(claim, now, job => {
      job.status = 'retry_wait';
      job.availableAt = retryAt;
      job.history.push({ at: now, event: 'write_deferred', stageId, code: error.code, message: error.message });
    });
  }

  fail(claim: Claim, stageId: string, error: WorkerError, now: number): Job | undefined {
    return this.settle(claim, now, job => {
      job.failures += 1;
      const retry = error.retryable && job.failures < job.workflow.maxAttempts;
      job.status = retry ? 'retry_wait' : 'failed';
      if (!retry) {
        for (const garment of job.garmentCompletions ?? []) {
          if (garment.status === 'retry_wait') garment.status = 'failed';
        }
      }
      job.availableAt = now + (retry ? job.workflow.retryDelayMs : 0);
      job.history.push({
        at: now, event: retry ? 'retry_scheduled' : 'failed', stageId, code: error.code, message: error.message,
      });
    });
  }

  importSheetFixtures(input: unknown): number {
    if (!Array.isArray(input) || !input.length) {
      throw new WorkerError('INVALID_SHEET_ROW', 'Supply one or more simulated Master Input rows.');
    }
    return this.transaction(() => {
      let imported = 0;
      const seen = new Set<number>();
      for (const entry of input as unknown[]) {
        const row = object(entry, 'Sheet fixture row');
        onlyKeys(row, ['rowNumber', 'cells'], 'Sheet fixture row');
        const rowNumber = integer(row.rowNumber, 'Sheet fixture row number', 1, Number.MAX_SAFE_INTEGER);
        if (seen.has(rowNumber)) throw new WorkerError('DUPLICATE_SHEET_ROW', 'The fixture repeats a physical row number.');
        seen.add(rowNumber);
        if (!Array.isArray(row.cells) || row.cells.length < 11) {
          throw new WorkerError('INVALID_SHEET_ROW', 'Fixture rows must contain positional cells A through K.');
        }
        const contents = JSON.stringify(row.cells);
        const existing = this.db.prepare('SELECT fixture FROM master_input_fixtures WHERE row_number = ?').get(rowNumber);
        if (existing) {
          if (existing.fixture !== contents) throw new WorkerError('FIXTURE_CONFLICT', 'An existing physical sheet row differs from the fixture.');
          continue;
        }
        this.db.prepare('INSERT INTO master_input_fixtures (row_number, cells, fixture) VALUES (?, ?, ?)')
          .run(rowNumber, contents, contents);
        imported += 1;
      }
      return imported;
    });
  }

  private inspectGarment(target: GarmentCompletionTarget, expectedProductId?: string): GarmentCompletion {
    const { sourceRow, productSku, artworkSku } = target;
    const report = { sourceRow, productSku };
    const row = this.db.prepare(`
      SELECT json_extract(cells, '$[8]') AS completion, json_type(cells, '$[8]') AS completion_type
      FROM master_input_fixtures
      WHERE row_number = ? AND json_extract(cells, '$[7]') = ? AND json_extract(cells, '$[10]') = ?
    `).get(sourceRow, productSku, artworkSku);
    if (!row) return { ...report, status: 'needs_review', code: 'SHEET_ROW_MISMATCH' };
    const duplicate = this.db.prepare(`
      SELECT row_number FROM master_input_fixtures WHERE json_extract(cells, '$[7]') = ? AND row_number <> ? LIMIT 1
    `).get(productSku, sourceRow);
    if (duplicate) return { ...report, status: 'needs_review', code: 'DUPLICATE_PRODUCT_SKU' };

    if (row.completion === 'Yes') return { ...report, status: 'already_completed' };
    if (row.completion_type !== 'null' && row.completion !== '') {
      return { ...report, status: 'needs_review', code: 'EXISTING_COMPLETION_VALUE' };
    }

    const product = resolveProduct(this.findShopifyBindings(productSku), artworkSku);
    const bound = { ...report, productId: product.id };
    if ((expectedProductId !== undefined && product.id !== expectedProductId)
      || (product.sourceRow !== undefined && product.sourceRow !== sourceRow)) {
      return { ...bound, status: 'needs_review', code: 'PRODUCT_BINDING_CONFLICT' };
    }
    const variants = this.db.prepare('SELECT id, sku FROM shopify_variants WHERE product_id = ? ORDER BY id').all(product.id);
    if (!variants.length) return { ...bound, status: 'needs_review', code: 'VARIANTS_NOT_FOUND' };

    const unexpected = variants.filter(variant => variant.sku !== null && variant.sku !== productSku);
    if (unexpected.length) {
      return { ...bound, status: 'needs_review', code: 'UNEXPECTED_VARIANT_SKU', variantIds: unexpected.map(row => row.id as string) };
    }
    const blank = variants.filter(variant => variant.sku === null);
    if (blank.length) {
      return { ...bound, status: 'pending_skus', variantIds: blank.map(row => row.id as string) };
    }
    return { ...bound, status: 'ready' };
  }

  sheetsCompletionAdapter(): SheetsCompletionAdapter {
    return {
      inspect: async target => this.inspectGarment(target),
      markComplete: async (target, productId) => this.transaction(() => {
        const report = this.inspectGarment(target, productId);
        if (report.status !== 'ready') return report;
        this.db.prepare(`
          UPDATE master_input_fixtures SET cells = json_set(cells, '$[8]', 'Yes')
          WHERE row_number = ? AND json_extract(cells, '$[7]') = ? AND json_extract(cells, '$[10]') = ?
            AND (json_type(cells, '$[8]') = 'null' OR json_extract(cells, '$[8]') = '')
        `).run(target.sourceRow, target.productSku, target.artworkSku);
        return { ...report, status: 'completed' };
      }),
    };
  }

  getExport(id: string): ExportJob {
    const row = this.db.prepare('SELECT body FROM mockupify_exports WHERE id = ?').get(id);
    if (!row) throw new WorkerError('EXPORT_NOT_FOUND', 'No Mockupify export matches that ID.');
    return JSON.parse(row.body as string) as ExportJob;
  }

  private saveExport(job: ExportJob): ExportJob {
    this.db.prepare('UPDATE mockupify_exports SET body = ?, export_ref = ? WHERE id = ?')
      .run(JSON.stringify(job), job.evidence?.exportRef ?? null, job.id);
    return job;
  }

  queueExport(plan: ExportPlan, mode: Mode, now: number): ExportJob {
    return this.transaction(() => {
      const identity = JSON.stringify([mode, plan.artworkSku]);
      const row = this.db.prepare('SELECT body FROM mockupify_exports WHERE identity = ?').get(identity);
      const previous = row ? JSON.parse(row.body as string) as ExportJob : undefined;
      if (previous && JSON.stringify(previous.plan) === JSON.stringify(plan)) return previous;
      if (previous && mode === 'simulate' && !previous.plan.issues.length) {
        throw new WorkerError('EXPORT_PLAN_CONFLICT', 'This artwork already has a different export plan.');
      }
      const status = plan.issues.length ? 'needs_review' : mode === 'dry-run' ? 'planned' : 'queued';
      const job: ExportJob = { id: previous?.id ?? randomUUID(), mode, plan, status, availableAt: now };
      if (previous) {
        this.saveExport(job);
      } else {
        this.db.prepare('INSERT INTO mockupify_exports (id, identity, body) VALUES (?, ?, ?)')
          .run(job.id, identity, JSON.stringify(job));
      }
      if (status === 'queued') {
        for (const garment of plan.products) {
          const reserved = this.db.prepare('SELECT export_id FROM mockupify_export_reservations WHERE product_sku = ?')
            .get(garment.productSku);
          if (reserved || this.findShopifyBindings(garment.productSku).length) {
            throw new WorkerError('EXPORT_PRODUCT_CONFLICT', 'A Product SKU is already bound or reserved for export.');
          }
          this.db.prepare('INSERT INTO mockupify_export_reservations (product_sku, export_id) VALUES (?, ?)')
            .run(garment.productSku, job.id);
        }
      }
      return job;
    });
  }

  beginExport(id: string, clock: () => number, marginMinutes: number | undefined): boolean {
    return this.transaction(() => {
      const job = this.getExport(id);
      if (job.mode !== 'simulate' || !['queued', 'deferred'].includes(job.status) || job.availableAt > clock()) return false;
      if (job.plan.products.some(row => this.findShopifyBindings(row.productSku).length)) {
        this.saveExport({ ...job, status: 'needs_review', code: 'EXPORT_PRODUCT_CONFLICT' });
        return false;
      }
      try {
        assertExportWindow(clock(), marginMinutes);
      } catch (error) {
        if (!(error instanceof ProductionWriteDeferred)) throw error;
        this.saveExport({ ...job, status: 'deferred', availableAt: error.retryAt, code: error.code });
        return false;
      }
      // Commit an irreversible dispatch claim before allowing the adapter to perform work.
      this.saveExport({ id, mode: job.mode, plan: job.plan, status: 'dispatching', availableAt: clock() });
      return true;
    });
  }

  deferExportBeforeDispatch(id: string, error: ProductionWriteDeferred): ExportJob {
    return this.transaction(() => {
      const job = this.getExport(id);
      if (job.status !== 'dispatching') return job;
      return this.saveExport({ ...job, status: 'deferred', availableAt: error.retryAt, code: error.code });
    });
  }

  markExportUncertain(id: string, code: string): ExportJob {
    return this.transaction(() => {
      const job = this.getExport(id);
      if (job.status !== 'dispatching' && job.status !== 'uncertain') return job;
      return this.saveExport({ ...job, status: 'uncertain', code });
    });
  }

  recordExportEvidence(id: string, input: unknown): ExportJob {
    return this.transaction(() => {
      const job = this.getExport(id);
      if (job.mode !== 'simulate' || !['dispatching', 'uncertain', 'completed'].includes(job.status)) {
        throw new WorkerError('EXPORT_NOT_RECONCILABLE', 'Only a dispatched export can accept reconciliation evidence.');
      }
      const { correlationId, exportRef, bindings } = parseExportEvidence(input, job);
      const owner = this.db.prepare('SELECT id FROM mockupify_exports WHERE export_ref = ?').get(exportRef);
      if ((job.evidence && job.evidence.exportRef !== exportRef) || (owner && owner.id !== id)) {
        throw new WorkerError('EXPORT_BINDING_CONFLICT', 'The Mockupify export reference does not match this dispatch.');
      }
      const merged = new Map(job.evidence?.bindings.map(binding => [binding.sourceRow, binding]));
      for (const binding of bindings) {
        const existing = merged.get(binding.sourceRow);
        if ((existing && JSON.stringify(existing) !== JSON.stringify(binding))
          || this.findShopifyBindings(binding.product.productSku).some(product => product.id !== binding.product.id)) {
          throw new WorkerError('EXPORT_BINDING_CONFLICT', 'An exported garment already has a conflicting Shopify binding.');
        }
        merged.set(binding.sourceRow, binding);
      }
      this.insertShopifyFixtures(bindings.map(binding => binding.product));
      const evidence = { correlationId, exportRef, bindings: [...merged.values()].sort((a, b) => a.sourceRow - b.sourceRow) };
      const { code: _, ...state } = job;
      return this.saveExport(merged.size === job.plan.products.length
        ? { ...state, status: 'completed', evidence }
        : { ...state, status: 'uncertain', code: 'PARTIAL_EXPORT_EVIDENCE', evidence });
    });
  }

  importShopifyFixtures(input: unknown): number {
    const products = parseShopifyCatalog(input);
    return this.transaction(() => this.insertShopifyFixtures(products));
  }

  private insertShopifyFixtures(products: ShopifyProduct[]): number {
    let imported = 0;
    for (const product of products) {
      const baseline = JSON.stringify(product);
      const row = this.db.prepare('SELECT fixture FROM shopify_products WHERE id = ?').get(product.id);
      if (row) {
        if (row.fixture !== baseline) {
          throw new WorkerError('FIXTURE_CONFLICT', 'An existing Shopify product fixture differs from this import.');
        }
        continue;
      }
      this.db.prepare('INSERT INTO shopify_products (id, artwork_sku, product_sku, fixture) VALUES (?, ?, ?, ?)')
        .run(product.id, product.artworkSku, product.productSku, baseline);
      for (const variant of product.variants) {
        if (this.db.prepare('SELECT id FROM shopify_variants WHERE id = ?').get(variant.id)) {
          throw new WorkerError('FIXTURE_CONFLICT', 'A Shopify variant ID is already registered to a product.');
        }
        this.db.prepare('INSERT INTO shopify_variants (id, product_id, size, color, sku) VALUES (?, ?, ?, ?, ?)')
          .run(variant.id, product.id, variant.size, variant.color, variant.sku);
      }
      imported += 1;
    }
    return imported;
  }

  private findShopifyBindings(productSku: string): ShopifyProductBinding[] {
    return this.db.prepare(`
      SELECT id, artwork_sku, json_extract(fixture, '$.mockupifyExportRef') AS export_ref,
        json_extract(fixture, '$.sourceRow') AS source_row
      FROM shopify_products WHERE product_sku = ? ORDER BY id
    `).all(productSku).map(row => ({
      id: row.id as string, artworkSku: row.artwork_sku as string, productSku,
      ...(typeof row.export_ref === 'string' ? { mockupifyExportRef: row.export_ref } : {}),
      ...(typeof row.source_row === 'number' ? { sourceRow: row.source_row } : {}),
    }));
  }

  private findShopifyProducts(productSku: string): ShopifyProduct[] {
    const variants = this.db.prepare('SELECT id, size, color, sku FROM shopify_variants WHERE product_id = ? ORDER BY id');
    return this.findShopifyBindings(productSku).map(binding => ({
      ...binding,
      variants: variants.all(binding.id).map(row => ({
        id: row.id as string, size: row.size as string, color: row.color as string, sku: row.sku as string | null,
      })),
    }));
  }

  private assignShopifySku(target: InitialSkuTarget, clock: () => number) {
    return this.transaction(() => {
      const product = resolveProduct(this.findShopifyBindings(target.productSku), target.artworkSku);
      const variant = this.db.prepare('SELECT sku FROM shopify_variants WHERE product_id = ? AND id = ?')
        .get(product.id, target.variantId);
      if (product.id !== target.productId || !variant) {
        throw new WorkerError('PRODUCT_BINDING_CONFLICT', 'The Shopify product or variant binding changed before assignment.');
      }
      const outcome = existingSku(variant.sku as string | null, target.productSku);
      if (outcome) return outcome;
      const update = this.db.prepare('UPDATE shopify_variants SET sku = ? WHERE product_id = ? AND id = ? AND sku IS NULL');
      assertSkuWindow(clock());
      update.run(target.productSku, target.productId, target.variantId);
      return { outcome: 'assigned' as const };
    });
  }

  shopifySkuAdapter(): ShopifySkuAdapter {
    return {
      findProducts: async productSku => this.findShopifyProducts(productSku),
      assignInitialSku: async (target, clock) => this.assignShopifySku(target, clock),
    };
  }

  applyEffect(
    key: string, action: WriteAction, request: Details, apply: () => Details, beforeWrite?: () => void,
  ): Effect {
    return this.transaction(() => {
      const payload = JSON.stringify(request);
      const row = this.db.prepare('SELECT action, request, details FROM effects WHERE key = ?').get(key);
      if (row) {
        if (row.action !== action || row.request !== payload) {
          throw new WorkerError('EFFECT_CONFLICT', 'An existing simulated write has a different request for this identity.');
        }
        return { details: JSON.parse(row.details as string) as Details, reused: true };
      }
      const details = apply();
      const insert = this.db.prepare('INSERT INTO effects (key, action, request, details) VALUES (?, ?, ?, ?)');
      const serialized = JSON.stringify(details);
      beforeWrite?.();
      insert.run(key, action, payload, serialized);
      return { details, reused: false };
    });
  }

  effectCounts(): Record<string, number> {
    return Object.fromEntries(this.db.prepare('SELECT action, COUNT(*) AS count FROM effects GROUP BY action').all()
      .map(row => [row.action as string, row.count as number]));
  }
}
