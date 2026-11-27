import { WorkerError } from './model.js';
import { protectedUntil } from './production-schedule.js';
import { verifyHextom } from './shopify-hextom.js';
import { sharesOwnerAssignment } from './shopify-matching.js';
import type { OwnerConfirmation } from './shopify-matching.js';
import { readStableShopifyProduct } from './shopify-readonly.js';
import type { ProductRead, ShopifyReadonlyClient } from './shopify-readonly.js';
import { findMasterInputSkuRow } from './shopify-reconciliation.js';
import type { SheetEvidence } from './shopify-reconciliation.js';

type RequestedBinding = Omit<OwnerConfirmation, 'confirmedBy' | 'spreadsheetId'>;
type SourceEvidence = { confirmations: readonly OwnerConfirmation[]; sheet: SheetEvidence };
type Action = 'UNCHANGED' | 'WOULD_ASSIGN' | 'NEEDS_REVIEW';

function checkBinding(binding: RequestedBinding, evidence?: SourceEvidence) {
  if (!evidence) return ['BINDING_NOT_VERIFIED'];
  const { sheet, confirmations } = evidence;
  const related = confirmations.filter(confirmation => sharesOwnerAssignment(binding, confirmation));
  const [match] = related;
  const issues: string[] = [];
  if (related.length > 1) issues.push('DUPLICATE_OWNER_ASSIGNMENT');
  else if (!match) issues.push('MISSING_OWNER_CONFIRMATION');
  else if (match.shopId !== binding.shopId || match.productId !== binding.productId || match.rowNumber !== binding.rowNumber
    || match.productSku !== binding.productSku || match.artworkSku !== binding.artworkSku) {
    issues.push('OWNER_CONFIRMATION_MISMATCH');
  }
  const finding = findMasterInputSkuRow(sheet, binding, binding.rowNumber);
  if (!finding.authoritative) issues.push('LIVE_MASTER_INPUT_REQUIRED');
  if (finding.status !== 'MATCHED') issues.push(`MASTER_INPUT_${finding.status}`);
  return issues;
}

function optionValue(options: ProductRead['variants'][number]['selectedOptions'], names: readonly string[]): string | null {
  const matches = options.filter(option => names.includes(option.name.toLowerCase()));
  return matches.length === 1 ? matches[0]!.value : null;
}

export async function previewShopifySkus(
  client: Pick<ShopifyReadonlyClient, 'product'>, configuredShopId: string, binding: RequestedBinding, evidence?: SourceEvidence,
) {
  if (binding.shopId !== configuredShopId) {
    throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The expected Shop GID must match the configured Shopify shop.');
  }
  const bindingIssues = checkBinding(binding, evidence);
  const bindingVerified = bindingIssues.length === 0;
  const product = await readStableShopifyProduct(client, binding.productId);
  const protectedWriteUntil = protectedUntil(Date.now());
  const context = {
    binding, bindingVerified, diagnosticOnly: evidence === undefined,
    futureWritesProtectedUntil: protectedWriteUntil === undefined ? null : new Date(protectedWriteUntil).toISOString(),
  };
  if (!product) {
    return { ...context, status: 'BLOCKED', issues: [...bindingIssues, 'SHOPIFY_SNAPSHOT_CHANGED'], variants: [] };
  }

  const verification = verifyHextom(product, binding.productSku);
  const variantShapeIssues = verification.issues.filter(issue => [
    'NO_VARIANTS', 'INVALID_OPTION_POSITIONS', 'INVALID_VARIANT_OPTIONS', 'MISSING_VARIANT_IDS',
    'DUPLICATE_VARIANT_IDS', 'DUPLICATE_EXPECTED_SKUS',
  ].includes(issue));
  const hextomStarted = verification.counts.TRANSFORMED > 0 || verification.counts.DUPLICATE_TRANSFORMATION > 0;
  // An unrecognized value with the expected base followed by a suffix could be a bad transformation.
  const possibleTransformation = verification.variants.some(variant => variant.status === 'UNEXPECTED_SKU'
    && variant.currentSku?.startsWith(`${binding.productSku}-`));
  const blockers = [...bindingIssues, ...variantShapeIssues];
  if (!verification.hasAdjustTag) blockers.push('ADJUST_TAG_MISSING');
  if (hextomStarted) blockers.push('HEXTOM_TRANSFORMATION_PRESENT');
  if (possibleTransformation) blockers.push('POSSIBLE_HEXTOM_TRANSFORMATION');

  const variants = verification.variants.map(variant => {
    const blank = variant.currentSku === null || variant.currentSku === '';
    let action: Action = 'NEEDS_REVIEW';
    let reason = variant.status === 'DUPLICATE_TRANSFORMATION' ? 'DUPLICATE_TRANSFORMATION' : 'EXISTING_NONBLANK_SKU';
    if (variantShapeIssues.length) {
      reason = 'VARIANT_DATA_REQUIRES_REVIEW';
    } else if (variant.status === 'INITIAL' || (bindingVerified && variant.status === 'TRANSFORMED')) {
      action = 'UNCHANGED';
      reason = variant.status === 'INITIAL' ? 'BASE_SKU_ALREADY_PRESENT' : 'TRANSFORMED_SKU_PRESERVED';
    } else if (blank) {
      if (blockers.length) reason = 'ASSIGNMENT_BLOCKED';
      else {
        action = 'WOULD_ASSIGN';
        reason = 'BLANK_SKU';
      }
    }
    return {
      variantId: variant.id, color: optionValue(variant.selectedOptions, ['color', 'colour']),
      size: optionValue(variant.selectedOptions, ['size']), selectedOptions: variant.selectedOptions,
      currentSku: variant.currentSku, proposedBaseSku: action === 'WOULD_ASSIGN' ? binding.productSku : null, action, reason,
    };
  });
  const counts: Record<Action, number> = { UNCHANGED: 0, WOULD_ASSIGN: 0, NEEDS_REVIEW: 0 };
  for (const variant of variants) counts[variant.action]++;
  const status = !evidence ? 'DIAGNOSTIC_ONLY' : blockers.length ? 'BLOCKED' : counts.NEEDS_REVIEW ? 'REVIEW_REQUIRED' : 'PREVIEW';
  return {
    ...context, status, issues: [...new Set([...blockers, ...verification.issues])],
    title: product.title, updatedAt: product.updatedAt, hasAdjustTag: verification.hasAdjustTag,
    variantCount: variants.length, counts, variants,
  };
}
