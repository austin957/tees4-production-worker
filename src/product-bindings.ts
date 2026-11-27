import { isDeepStrictEqual } from 'node:util';
import { integer, object, onlyKeys, requiredText } from './config.js';
import { WorkerError } from './model.js';
import { masterInput } from './sheets.js';
import { readStableShopifyProduct, shopifyGid } from './shopify-readonly.js';
import type { ProductRead, ShopifyReadonlyClient } from './shopify-readonly.js';
import { findMasterInputSkuRow } from './shopify-reconciliation.js';
import type { SheetEvidence } from './shopify-reconciliation.js';
import type { Store } from './store.js';

export interface BindingAssignment {
  spreadsheetId: string;
  rowNumber: number;
  productSku: string;
  artworkSku: string;
  shopId: string;
  productId: string;
}

export interface BindingConfirmation {
  by: string;
  source: string;
  at: number;
}

export interface ProductBinding extends BindingAssignment {
  id: string;
  status: 'proposed' | 'approved' | 'rejected' | 'stale';
  createdAt: number;
  updatedAt: number;
  shopifySnapshot: ProductRead;
  confirmation: BindingConfirmation | null;
}

type VerifiedReview = 'approve' | 'recheck';
type AuditEntry = { at: number; by: string };
export type BindingReviewEvent = AuditEntry & (
  | { event: 'approved'; source: string }
  | { event: 'rejected'; reason: string }
  | { event: 'revalidated' }
  | { event: 'stale' | 'verification_failed'; review: VerifiedReview; code: string }
);
export type BindingEvent = (BindingReviewEvent | (AuditEntry & { event: 'proposed' })) & {
  from: ProductBinding['status'] | null;
  to: ProductBinding['status'];
};

interface ShopifyEvidence {
  shopId: string;
  shopify: Pick<ShopifyReadonlyClient, 'product'>;
}

interface LiveEvidence extends ShopifyEvidence {
  readMasterInput: () => Promise<SheetEvidence>;
}

type Review = { action: 'approve'; by: string; source: string } | { action: 'recheck'; by: string };

export function parseBindingAssignment(input: unknown): BindingAssignment {
  const value = object(input, 'Product binding assignment');
  onlyKeys(value, ['spreadsheetId', 'rowNumber', 'productSku', 'artworkSku', 'shopId', 'productId'], 'Product binding assignment');
  if (value.spreadsheetId !== masterInput.spreadsheetId) {
    throw new WorkerError('SOURCE_SHEET_MISMATCH', 'The assignment must refer to Design Input Master.');
  }
  return {
    spreadsheetId: value.spreadsheetId, rowNumber: integer(value.rowNumber, 'Physical Master Input row', 1, Number.MAX_SAFE_INTEGER),
    productSku: requiredText(value.productSku, 'Product SKU'), artworkSku: requiredText(value.artworkSku, 'Artwork SKU'),
    shopId: shopifyGid(value.shopId, 'Shop'), productId: shopifyGid(value.productId, 'Product'),
  };
}

async function readBindingProduct(assignment: BindingAssignment, evidence: ShopifyEvidence) {
  if (evidence.shopId !== assignment.shopId) {
    throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The assignment is for a different Shopify shop.');
  }
  const product = await readStableShopifyProduct(evidence.shopify, assignment.productId);
  if (!product) throw new WorkerError('SHOPIFY_PRODUCT_CHANGED', 'Shopify changed during the product read.');
  if (product.id !== assignment.productId) {
    throw new WorkerError('SHOPIFY_PRODUCT_MISMATCH', 'The product returned by Shopify differs from the requested GID.');
  }
  const ids = product.variants.map(variant => variant.id);
  if (!ids.length || ids.includes(null) || new Set(ids).size !== ids.length) {
    throw new WorkerError('SHOPIFY_VARIANT_IDS_INVALID', 'The Shopify product must have complete and unique variant GIDs.');
  }
  return product;
}

export async function proposeProductBinding(
  store: Pick<Store, 'createProductBinding'>, assignment: BindingAssignment, by: string, evidence: ShopifyEvidence,
  clock = Date.now,
) {
  const actor = requiredText(by, 'Proposer');
  const snapshot = await readBindingProduct(assignment, evidence);
  return store.createProductBinding(assignment, actor, snapshot, clock());
}

type VerificationIssue = { event: 'stale' | 'verification_failed'; code: string };

async function verifyBindingSource(binding: ProductBinding, read: LiveEvidence['readMasterInput']): Promise<VerificationIssue | null> {
  let source;
  try {
    source = await read();
  } catch (error) {
    if (!(error instanceof WorkerError)) throw error;
    return { event: 'verification_failed', code: error.code };
  }
  if (source.kind === 'unavailable') return { event: 'verification_failed', code: source.code };
  if (source.kind !== 'live') return { event: 'verification_failed', code: 'LIVE_MASTER_INPUT_REQUIRED' };
  const finding = findMasterInputSkuRow(source, binding, binding.rowNumber);
  return finding.status === 'MATCHED' ? null : { event: 'stale', code: `MASTER_INPUT_${finding.status}` };
}

async function verifyBinding(binding: ProductBinding, evidence: LiveEvidence): Promise<VerificationIssue | null> {
  if (evidence.shopId !== binding.shopId) return { event: 'verification_failed', code: 'SHOPIFY_SHOP_MISMATCH' };
  const sourceIssue = await verifyBindingSource(binding, evidence.readMasterInput);
  if (sourceIssue) return sourceIssue;
  try {
    const product = await readBindingProduct(binding, evidence);
    if (!isDeepStrictEqual(product, binding.shopifySnapshot)) return { event: 'stale', code: 'SHOPIFY_SNAPSHOT_CHANGED' };
  } catch (error) {
    if (!(error instanceof WorkerError)) throw error;
    const changed = ['SHOPIFY_PRODUCT_CHANGED', 'SHOPIFY_PRODUCT_NOT_FOUND', 'SHOPIFY_PRODUCT_MISMATCH', 'SHOPIFY_VARIANT_IDS_INVALID'];
    return { event: changed.includes(error.code) ? 'stale' : 'verification_failed', code: error.code };
  }
  return verifyBindingSource(binding, evidence.readMasterInput);
}

export async function reviewProductBinding(
  store: Pick<Store, 'getProductBinding' | 'recordProductBindingReview'>, id: string, review: Review, evidence: LiveEvidence,
  clock = Date.now,
) {
  const binding = store.getProductBinding(id);
  const expectedStatus = review.action === 'approve' ? 'proposed' : 'approved';
  if (binding.status !== expectedStatus) {
    throw new WorkerError('BINDING_REVIEW_CONFLICT', `This review requires a ${expectedStatus} binding.`);
  }
  const by = requiredText(review.by, 'Reviewer');
  const source = review.action === 'approve' ? requiredText(review.source, 'Owner confirmation evidence reference') : null;
  const issue = await verifyBinding(binding, evidence);
  const audit = { at: clock(), by };
  if (issue) return store.recordProductBindingReview(id, { ...audit, ...issue, review: review.action });
  return store.recordProductBindingReview(id, source === null
    ? { ...audit, event: 'revalidated' } : { ...audit, event: 'approved', source });
}
