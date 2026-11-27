import { createHash } from 'node:crypto';
import type { MockupifyPreparationRecord, parseMockupifyPreparationInput } from './mockupify-preparation.js';
import { WorkerError } from './model.js';

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
  expectedInitialDescription?: {
    source: 'uploaded_design_only';
    text: string;
    evidence: string;
  };
  variantOptionsEvidence?: string;
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

export interface MockupifyExportReviewInput {
  descriptionSourceEvidence: string;
  variantOptionsEvidence: string;
  publicationSafety: MockupifyReview['publicationSafety'];
}

export function hasUploadedDescriptionReview(review: MockupifyReviewInput): boolean {
  const expected = review.expectedInitialDescription;
  return expected?.source === 'uploaded_design_only' && !!expected.evidence.trim() &&
    !!expected.text.trim() && expected.text === review.design.description &&
    review.product.descriptionHtml === null && review.initialDescriptionEvidence === undefined;
}

export function unresolvedMockupifyReview(review: MockupifyReviewInput, operation: MockupifyOperation = 'start_export'): string[] {
  const missing: string[] = [];
  if (operation === 'start_export') {
    if (review.expectedInitialDescription) {
      if (!hasUploadedDescriptionReview(review)) missing.push('expectedInitialDescription');
      if (!review.variantOptionsEvidence?.trim()) missing.push('variantOptionsEvidence');
    } else {
      if (!review.product.descriptionHtml?.trim()) missing.push('product.descriptionHtml');
      if (!review.initialDescriptionEvidence?.trim()) missing.push('initialDescriptionEvidence');
    }
    if (!review.publicationSafety) missing.push('publicationSafety');
    if (!review.product.title?.trim()) missing.push('product.title');
    if (!review.product.variants?.length) missing.push('product.variants');
  }
  if (!review.exclusiveBatchControlEvidence?.trim()) missing.push('exclusiveBatchControlEvidence');
  return missing;
}

export function assertMockupifyOperationReview(journal: MockupifyJournal, operation: MockupifyOperation): void {
  const missing = unresolvedMockupifyReview(journal.plan.review, operation);
  if (missing.length) {
    throw new WorkerError('MOCKUPIFY_PENDING_REVIEW', `Supply verified evidence for ${missing.join(', ')} before ${operation}.`);
  }
  if (operation === 'start_export' && journal.registrationState === 'pending_review') {
    throw new WorkerError('MOCKUPIFY_PENDING_REVIEW', 'Finalize the Shopify export review before approving or claiming an export.');
  }
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
