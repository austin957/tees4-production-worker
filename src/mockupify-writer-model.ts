import { createHash } from 'node:crypto';
import type { MockupifyPreparationRecord, parseMockupifyPreparationInput } from './mockupify-preparation.js';

export const mockupifyOperations = ['create_batch', 'upload_design', 'start_export'] as const;
export type MockupifyOperation = typeof mockupifyOperations[number];

export interface SupervisedDesignFields {
  title: string;
  description: string;
  extra_title: string;
  search_tags: string;
  vendor: string;
  extra_price: string;
}

export interface SupervisedSourceRow {
  sourceRow: number;
  sheetArtworkName: string | null;
  title: string | null;
  description: string | null;
  vendor: string | null;
  tags: string | null;
  garment: string | null;
  rawColors: string | null;
  productSku: string | null;
  artworkSku: string | null;
  completion: string | null;
}

export interface MockupifyReview {
  artworkRegistryName: string;
  designerAttribution: string;
  artworkNameResolution?: string;
  design: SupervisedDesignFields;
  shop: { id: string; domain: string; connectionEvidence: string };
  product: {
    title: string;
    descriptionHtml: string;
    vendor: string;
    tags: string[];
    variants: { options: Record<string, string>; price: string }[];
    status: 'ACTIVE';
  };
  exclusiveBatchControlEvidence: string;
  initialDescriptionEvidence?: string;
  publicationSafety: {
    evidence: string;
    startsAt: number;
    endsAt: number;
    minimumMinutes: number;
  };
}

export type MockupifyReviewInput = Omit<MockupifyReview, 'product' | 'publicationSafety' | 'exclusiveBatchControlEvidence'> & {
  product: Omit<MockupifyReview['product'], 'title' | 'descriptionHtml' | 'variants'> & {
    title: string | null;
    descriptionHtml: string | null;
    variants: MockupifyReview['product']['variants'] | null;
  };
  exclusiveBatchControlEvidence: string | null;
  publicationSafety: MockupifyReview['publicationSafety'] | null;
};

export function unresolvedMockupifyReview(review: MockupifyReviewInput): string[] {
  const missing: string[] = [];
  if (review.product.descriptionHtml === null) missing.push('product.descriptionHtml');
  if (!review.initialDescriptionEvidence?.trim()) missing.push('initialDescriptionEvidence');
  if (review.publicationSafety === null) missing.push('publicationSafety');
  if (review.product.title === null) missing.push('product.title');
  if (review.product.variants === null) missing.push('product.variants');
  if (review.exclusiveBatchControlEvidence === null) missing.push('exclusiveBatchControlEvidence');
  return missing;
}

export interface SupervisedMockupifyPlan {
  mode: 'simulate' | 'production';
  correlation: MockupifyPreparationRecord;
  source: SupervisedSourceRow;
  sourceEvidence?: string;
  review: MockupifyReviewInput;
  colors: ReturnType<typeof parseMockupifyPreparationInput>['colors'];
  catalogColors: { id: number; name: string; price: string; sizes: string[] }[];
  artwork: ReturnType<typeof parseMockupifyPreparationInput>['png'];
}

export type MockupifyPost =
  | { operation: 'create_batch'; path: '/api/batches/'; json: { name: string } }
  | { operation: 'upload_design'; path: '/api/designs/'; fields: SupervisedDesignFields & {
    batch: number; design_id: string }; file: { name: 'review.png'; type: 'image/png'; sha256: string } }
  | { operation: 'start_export'; path: '/api/exports/'; json: { batch: number; colors: number[] } };

export interface MockupifyApproval {
  operation: MockupifyOperation;
  digest: string;
  by: string;
  evidence: string;
  expiresAt: number;
}

export interface MockupifyClaim {
  request: MockupifyPost;
  requestDigest: string;
  approval: MockupifyApproval;
  claimedAt: number;
  budgetSequence?: number;
  designId: number | null;
  state: 'dispatching' | 'uncertain' | 'acknowledged' | 'recovered';
  outcomeCode?: string;
}

export interface MockupifyJournal {
  plan: SupervisedMockupifyPlan;
  registrationState?: 'pending_review' | 'finalized';
  revision: number;
  batchId: number | null;
  designId: number | null;
  exportId: number | null;
  exportTerminal: boolean;
  exportStatus: 'unobserved' | 'pending' | 'held' | 'validated_for_binding_review';
  observedProductGids: string[];
  shopifyProductGid: string | null;
  publicationObserved?: boolean;
  claims: Partial<Record<MockupifyOperation, MockupifyClaim>>;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function mockupifyDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}
