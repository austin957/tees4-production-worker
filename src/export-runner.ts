import type { ExportJob, MockupifyExportAdapter } from './mockupify.js';
import { WorkerError } from './model.js';
import { assertExportWindow, ProductionWriteDeferred } from './production-schedule.js';
import type { Store } from './store.js';

export async function runMockupifyExport(
  store: Store, id: string, adapter: MockupifyExportAdapter, clock: () => number, marginMinutes?: number,
): Promise<ExportJob> {
  const job = store.getExport(id);
  if (job.mode !== 'simulate' || !['queued', 'deferred'].includes(job.status) || job.availableAt > clock()) return job;

  let dispatched = false;
  try {
    const evidence = await adapter.export(job.plan, id, () => {
      if (dispatched) throw new WorkerError('EXPORT_ALREADY_DISPATCHED', 'A dispatch can start only once.');
      if (!store.beginExport(id, clock, marginMinutes)) return false;
      try {
        // SQLite may have waited for a write lock or finished committing as the cutoff passed.
        assertExportWindow(clock(), marginMinutes);
      } catch (error) {
        if (!(error instanceof ProductionWriteDeferred)) throw error;
        store.deferExportBeforeDispatch(id, error);
        return false;
      }
      dispatched = true;
      return true;
    });
    if (!dispatched) return store.getExport(id);
    if (evidence === undefined) return store.markExportUncertain(id, 'EXPORT_RESULT_UNKNOWN');
    return store.recordExportEvidence(id, evidence);
  } catch (error) {
    if (!dispatched) throw error;
    const code = error instanceof WorkerError ? error.code : 'EXPORT_RESULT_UNKNOWN';
    return store.markExportUncertain(id, code);
  }
}
