import { object, onlyKeys, readJson, requiredText } from './config.js';
import { mockupifyDigest } from './mockupify-writer-model.js';
import { WorkerError } from './model.js';

type HextomPause = {
  shopId: string;
  productId: string;
  paused: true;
  verifiedBy: string;
  source: string;
  verifiedAt: number;
  holdUntil: number;
};

export type HextomPauseReader = () => unknown;

export function hextomPauseReader(env: NodeJS.ProcessEnv): HextomPauseReader {
  return () => readJson(requiredText(env.TEES4_HEXTOM_SKU_PAUSE_FILE, 'Hextom pause evidence file'), 'Hextom pause evidence');
}

export function verifyHextomPause(
  readPause: HextomPauseReader, target: { shopId: string; productId: string }, clock: () => number, minimumRemaining = 0,
) {
  try {
    const value = object(readPause(), 'Hextom pause evidence');
    onlyKeys(value, ['shopId', 'productId', 'paused', 'verifiedBy', 'source', 'verifiedAt', 'holdUntil'], 'Hextom pause evidence');
    const { verifiedAt, holdUntil } = value;
    const now = clock();
    if (value.shopId !== target.shopId || value.productId !== target.productId || value.paused !== true ||
      typeof verifiedAt !== 'number' || !Number.isSafeInteger(verifiedAt) || verifiedAt > now ||
      typeof holdUntil !== 'number' || !Number.isSafeInteger(holdUntil) ||
      holdUntil <= now + minimumRemaining || holdUntil - verifiedAt > 15 * 60_000) {
      throw new Error('Invalid Hextom pause.');
    }
    const pause: HextomPause = { shopId: target.shopId, productId: target.productId, paused: true,
      verifiedBy: requiredText(value.verifiedBy, 'Hextom pause verifier'),
      source: requiredText(value.source, 'Hextom pause evidence reference'), verifiedAt, holdUntil };
    return { ...pause, digest: mockupifyDigest(JSON.stringify(pause)) };
  } catch {
    throw new WorkerError('SKU_EXECUTION_HEXTOM_HOLD', 'Current independent Hextom pause evidence for this Shopify product is required.');
  }
}

export type VerifiedHextomPause = ReturnType<typeof verifyHextomPause>;
