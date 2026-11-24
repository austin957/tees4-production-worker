import { WorkerError } from './model.js';
import type { Artwork, Details, ReadAction, WriteAction } from './model.js';
import type { Store } from './store.js';

type Read = (artwork: Readonly<Artwork>) => Promise<Details>;
interface WriteRequest {
  artwork: Readonly<Artwork>;
  key: string;
}
interface WriteResult {
  details: Details;
  reused: boolean;
}
type Write = (request: WriteRequest) => Promise<WriteResult>;

export interface GoogleDriveAdapter { readArtwork: Read }
export interface GoogleSheetsAdapter { readAssignment: Read }
export interface MockupifyAdapter { generate: Write }
export interface ShopifyAdapter { create: Write; publish: Write }
export interface TeeInBlueAdapter { readDesign: Read }
export interface FlashTransfersAdapter { readProduct: Read }
export interface DesignEngineAdapter { readDesign: Read }
export interface AffiliatePortalAdapter { readSubmission: Read }

export interface Adapters {
  drive: GoogleDriveAdapter;
  sheets: GoogleSheetsAdapter;
  mockupify: MockupifyAdapter;
  shopify: ShopifyAdapter;
  teeinblue: TeeInBlueAdapter;
  flashTransfers: FlashTransfersAdapter;
  designEngine: DesignEngineAdapter;
  affiliatePortal: AffiliatePortalAdapter;
}

export function simulatedAdapters(store: Store): Adapters {
  return {
    drive: { readArtwork: async artwork => ({ artworkRef: artwork.artworkRef }) },
    sheets: { readAssignment: async artwork => ({ sku: artwork.sku, productTitle: artwork.productTitle }) },
    affiliatePortal: { readSubmission: async artwork => ({ designerId: artwork.designerId }) },
    teeinblue: { readDesign: async artwork => ({ artworkId: artwork.artworkId }) },
    flashTransfers: { readProduct: async artwork => ({ sku: artwork.sku }) },
    designEngine: { readDesign: async artwork => ({ artworkId: artwork.artworkId }) },
    mockupify: {
      generate: async ({ artwork, key }) => store.applyEffect(key, 'mockupify.generate', { ...artwork }, () => ({
        mockupRef: `fixture://mockupify/${encodeURIComponent(artwork.artworkId)}/${encodeURIComponent(artwork.sku)}`,
      })),
    },
    shopify: {
      create: async ({ artwork, key }) => store.applyEffect(key, 'shopify.create', { ...artwork }, () => ({
        sku: artwork.sku, designerId: artwork.designerId, productRef: productRef(artwork), publication: 'draft',
      })),
      publish: async ({ artwork, key }) => store.applyEffect(key, 'shopify.publish', { ...artwork }, () => ({
        productRef: productRef(artwork), publication: 'published',
      })),
    },
  };
}

function productRef(artwork: Readonly<Artwork>): string {
  return `fixture://shopify/${encodeURIComponent(artwork.sku)}`;
}

export function effectKey(action: WriteAction, artwork: Readonly<Artwork>): string {
  return JSON.stringify(action === 'mockupify.generate'
    ? [action, artwork.artworkId, artwork.sku]
    : [action, artwork.sku]);
}

export function readAction(adapters: Adapters, action: ReadAction, artwork: Readonly<Artwork>): Promise<Details> {
  switch (action) {
    case 'drive.readArtwork': return adapters.drive.readArtwork(artwork);
    case 'sheets.readAssignment': return adapters.sheets.readAssignment(artwork);
    case 'affiliatePortal.readSubmission': return adapters.affiliatePortal.readSubmission(artwork);
    case 'teeinblue.readDesign': return adapters.teeinblue.readDesign(artwork);
    case 'flashTransfers.readProduct': return adapters.flashTransfers.readProduct(artwork);
    case 'designEngine.readDesign': return adapters.designEngine.readDesign(artwork);
  }
}

export function writeAction(adapters: Adapters, action: WriteAction, artwork: Readonly<Artwork>): Promise<WriteResult> {
  const request = { artwork, key: effectKey(action, artwork) };
  switch (action) {
    case 'mockupify.generate': return adapters.mockupify.generate(request);
    case 'shopify.create': return adapters.shopify.create(request);
    case 'shopify.publish': return adapters.shopify.publish(request);
  }
}

export function verifyRead(action: ReadAction, details: Details, artwork: Readonly<Artwork>): void {
  const required: Partial<Record<ReadAction, Details>> = {
    'drive.readArtwork': { artworkRef: artwork.artworkRef },
    'sheets.readAssignment': { sku: artwork.sku, productTitle: artwork.productTitle },
    'affiliatePortal.readSubmission': { designerId: artwork.designerId },
  };
  for (const [key, value] of Object.entries(required[action] ?? {})) {
    if (details[key] !== value) {
      throw new WorkerError('SOURCE_MISMATCH', `The simulated source response is missing or differs from the job's ${key}.`);
    }
  }
}
