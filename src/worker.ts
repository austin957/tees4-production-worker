import { readAction, verifyRead, writeAction } from './adapters.js';
import type { Adapters } from './adapters.js';
import { parseMode, parseWorkflow } from './config.js';
import { asWorkerError, isProduction, isWrite, skuAction, WorkerError } from './model.js';
import type { Job, StageResult } from './model.js';
import { parseJobArtwork } from './sheets.js';
import { assignSkus, protectedUntil, SkuWriteDeferred } from './shopify-skus.js';
import type { ShopifySkuAdapter } from './shopify-skus.js';
import type { Store } from './store.js';

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  event: string;
  jobId: string;
  stageId?: string;
  code?: string;
  message?: string;
}
type Logger = (entry: LogEntry) => void;

export class Worker {
  constructor(
    private readonly store: Store,
    private readonly adapters: Adapters,
    private readonly log: Logger = () => {},
    private readonly clock: () => number = Date.now,
    private readonly shopifySkus: ShopifySkuAdapter = store.shopifySkuAdapter(),
  ) {}

  submit(input: unknown, workflow: unknown, mode: unknown = 'dry-run'): { job: Job; duplicate: boolean } {
    const artwork = parseJobArtwork(input);
    const definition = parseWorkflow(workflow);
    const actions = definition.stages.flatMap(stage => stage.kind === 'action' ? [stage.action] : []);
    if (isProduction(artwork)
      ? !actions.includes(skuAction) || actions.some(action => action !== skuAction)
      : actions.includes(skuAction)) {
      throw new WorkerError('WORKFLOW_INPUT_MISMATCH', 'The sheet-backed artwork and Shopify SKU assignment stage must be used together.');
    }
    const result = this.store.submit(artwork, definition, parseMode(mode), this.clock());
    this.emit(result.job, result.duplicate ? 'duplicate_submission' : 'submitted');
    return result;
  }

  approve(id: string, stageId: string, approver: string): Job {
    if (!approver.trim() || approver !== approver.trim() || /\p{Cc}/u.test(approver)) {
      throw new WorkerError('INVALID_APPROVER', 'Provide a nonempty approver without surrounding whitespace or control characters.');
    }
    const job = this.store.approve(id, stageId, approver, this.clock());
    this.emit(job, 'approval_recorded', stageId);
    return job;
  }

  private emit(job: Job, event: string, stageId?: string, error?: WorkerError): void {
    const level = event === 'failed' ? 'error' : error || event === 'lease_recovered' || event === 'needs_review' ? 'warn' : 'info';
    this.log({
      at: this.clock(), level, event, jobId: job.id,
      ...(stageId === undefined ? {} : { stageId }),
      ...(error === undefined ? {} : { code: error.code, message: error.message }),
    });
  }

  async runAvailable(limit = 100): Promise<{ processed: number; failed: string[] }> {
    let processed = 0;
    const failed: string[] = [];
    while (processed < limit) {
      const claim = this.store.claim(this.clock());
      if (!claim) break;
      processed += 1;
      const { job } = claim;
      const stage = job.workflow.stages[job.nextStage]!;
      if (job.history.at(-2)?.event === 'lease_recovered') this.emit(job, 'lease_recovered', stage.id);
      this.emit(job, 'stage_started', stage.id);
      if (stage.kind === 'approval') {
        const updated = this.store.pause(claim, stage.id, this.clock());
        this.emit(job, updated ? 'approval_required' : 'lease_lost', stage.id);
        continue;
      }

      let result: StageResult;
      try {
        result = await this.execute(job);
      } catch (caught) {
        if (caught instanceof SkuWriteDeferred) {
          const updated = this.store.defer(claim, stage.id, caught, caught.retryAt, this.clock());
          this.emit(job, updated ? 'write_deferred' : 'lease_lost', stage.id, caught);
          continue;
        }
        const error = asWorkerError(caught);
        const updated = this.store.fail(claim, stage.id, error, this.clock());
        if (updated?.status === 'failed') failed.push(job.id);
        const event = updated?.status === 'retry_wait' ? 'retry_scheduled' : updated ? 'failed' : 'lease_lost';
        this.emit(job, event, stage.id, error);
        continue;
      }
      const updated = this.store.finish(claim, result, this.clock());
      this.emit(job, updated ? result.outcome : 'lease_lost', stage.id);
      if (updated?.status === 'completed' || updated?.status === 'needs_review') this.emit(job, updated.status);
    }
    return { processed, failed };
  }

  private async execute(job: Job): Promise<StageResult> {
    const stage = job.workflow.stages[job.nextStage]!;
    const stageId = stage.id;
    if (stage.kind === 'validate') {
      parseJobArtwork(job.artwork);
      return { stageId, outcome: 'validated' };
    }
    if (stage.kind !== 'action') throw new WorkerError('INVALID_STAGE', 'Expected an action stage.');
    const { action } = stage;
    if (isProduction(job.artwork)) {
      if (action !== skuAction) throw new WorkerError('WORKFLOW_INPUT_MISMATCH', 'This action requires Phase 1 fixture artwork.');
      if (job.mode !== 'dry-run' && job.mode !== 'simulate') throw new WorkerError('INVALID_MODE', 'No supported mode was selected.');
      const skuAssignments = await assignSkus(job.artwork, job.mode, this.shopifySkus, this.clock);
      const dryRun = job.mode === 'dry-run';
      const blockedUntil = dryRun ? protectedUntil(this.clock()) : undefined;
      return {
        stageId, outcome: dryRun ? 'planned' : skuAssignments.some(variant => variant.outcome === 'assigned') ? 'applied' : 'reused',
        ...(blockedUntil === undefined ? {} : { details: { skuWritesProtectedUntil: new Date(blockedUntil).toISOString() } }),
        skuAssignments,
      };
    }
    if (action === skuAction) throw new WorkerError('WORKFLOW_INPUT_MISMATCH', 'SKU assignment requires sheet-backed artwork.');
    if (!isWrite(action)) {
      const details = await readAction(this.adapters, action, job.artwork);
      verifyRead(action, details, job.artwork);
      return { stageId, outcome: 'read', details };
    }
    if (action === 'shopify.publish') {
      const gate = job.workflow.stages.slice(0, job.nextStage).findLast(candidate => candidate.kind === 'approval');
      if (!gate || !job.results.some(result => result.stageId === gate.id && result.outcome === 'approved')) {
        throw new WorkerError('APPROVAL_REQUIRED', 'Publication requires a recorded approval for this job.');
      }
    }

    if (job.mode === 'dry-run') return { stageId, outcome: 'planned', details: { action, sku: job.artwork.sku } };
    if (job.mode !== 'simulate') throw new WorkerError('INVALID_MODE', 'No write-capable mode was selected.');
    const written = await writeAction(this.adapters, action, job.artwork);
    return { stageId, outcome: written.reused ? 'reused' : 'applied', details: written.details };
  }
}

export function report(job: Job) {
  return {
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    workflow: job.workflow.id,
    artwork: job.artwork,
    submittedAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.status === 'awaiting_approval' ? { awaitingApproval: job.workflow.stages[job.nextStage]?.id } : {}),
    ...(job.status === 'retry_wait' ? { retryAt: job.availableAt } : {}),
    stages: job.results,
    history: job.history,
  };
}
