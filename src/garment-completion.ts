import { assignSkus } from './shopify-skus.js';
import type { ShopifySkuAdapter } from './shopify-skus.js';
import { ProductionWriteDeferred } from './production-schedule.js';
import { WorkerError } from './model.js';
import type { GarmentCompletion, Mode, ProductionArtwork } from './model.js';

export interface GarmentCompletionTarget {
  sourceRow: number;
  artworkSku: string;
  productSku: string;
}

// The writer verifies the physical row and re-reads the bound variants as part of the same simulated write.
export interface SheetsCompletionAdapter {
  inspect(target: GarmentCompletionTarget): Promise<GarmentCompletion>;
  markComplete(target: GarmentCompletionTarget, productId: string): Promise<GarmentCompletion>;
}

export async function completeGarments(
  artwork: ProductionArtwork, mode: Mode, sheets: SheetsCompletionAdapter, shopify: ShopifySkuAdapter,
  clock: () => number, checkpoint: (report: GarmentCompletion) => void,
  previous: readonly GarmentCompletion[],
): Promise<boolean> {
  let deferred: ProductionWriteDeferred | undefined;
  let retry: WorkerError | undefined;
  let applied = previous.some(row => row.status === 'completed');
  for (const garment of artwork.garments) {
    if (previous.some(row => row.sourceRow === garment.sourceRow && row.status === 'completed')) continue;
    const target = { sourceRow: garment.sourceRow, artworkSku: artwork.artworkSku, productSku: garment.productSku };
    let outcome: GarmentCompletion;
    let productId: string | undefined;
    try {
      outcome = await sheets.inspect(target);
      productId = outcome.productId;
      if (mode === 'simulate' && (outcome.status === 'pending_skus' || outcome.status === 'ready')) {
        if (!productId) throw new WorkerError('PRODUCT_BINDING_CONFLICT', 'The completion target has no bound product ID.');
        if (outcome.status === 'pending_skus') {
          await assignSkus({ ...artwork, garments: [garment] }, mode, shopify, clock, productId);
        }
        outcome = await sheets.markComplete(target, productId);
        if (outcome.status === 'pending_skus') {
          throw new WorkerError('VARIANT_SKUS_PENDING', 'A bound variant is still missing its initial SKU.', true);
        }
        applied ||= outcome.status === 'completed';
      }
    } catch (error) {
      if (!(error instanceof WorkerError)) throw error;
      const progress = {
        sourceRow: target.sourceRow, productSku: target.productSku, code: error.code,
        ...(productId === undefined ? {} : { productId }),
      };
      if (error instanceof ProductionWriteDeferred) {
        if (!deferred || error.retryAt < deferred.retryAt) deferred = error;
        outcome = { ...progress, status: 'deferred' };
      } else if (error.retryable) {
        retry ??= error;
        outcome = { ...progress, status: 'retry_wait' };
      } else {
        outcome = { ...progress, status: 'needs_review' };
      }
    }
    checkpoint(outcome);
  }
  if (deferred) throw deferred;
  if (retry) throw retry;
  return applied;
}
