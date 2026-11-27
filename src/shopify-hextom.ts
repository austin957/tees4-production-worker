import { adjustTag } from './shopify-readonly.js';
import type { ProductRead, ProductVariantRead } from './shopify-readonly.js';

type VariantStatus = 'INITIAL' | 'TRANSFORMED' | 'DUPLICATE_TRANSFORMATION' | 'MISSING_SKU' | 'UNEXPECTED_SKU'
  | 'INVALID_OPTIONS' | 'UNVERIFIED_BASE';

function classifySku(current: string | null, base: string | null, suffix: string | null): VariantStatus {
  if (current === null || current.trim() === '') return 'MISSING_SKU';
  if (base === null) return 'UNVERIFIED_BASE';
  if (suffix === null) return 'INVALID_OPTIONS';
  if (current === base) return 'INITIAL';
  const expected = base + suffix;
  if (current === expected) return 'TRANSFORMED';
  if (current.startsWith(expected)) {
    const extra = current.slice(expected.length);
    if (extra.length % suffix.length === 0 && extra === suffix.repeat(extra.length / suffix.length)) {
      return 'DUPLICATE_TRANSFORMATION';
    }
  }
  return 'UNEXPECTED_SKU';
}

function optionValue(variant: ProductVariantRead, optionName: string): string | null {
  const matches = variant.selectedOptions.filter(option => option.name === optionName);
  const value = matches[0]?.value;
  return matches.length === 1 && value?.trim() ? value : null;
}

function duplicates(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (value === null) continue;
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

export function verifyHextom(product: ProductRead, verifiedBaseSku?: string) {
  const base = verifiedBaseSku?.trim() ? verifiedBaseSku : null;
  const hasAdjustTag = product.tags.includes(adjustTag);
  const firstPositions = product.options.filter(option => option.position <= 2).sort((a, b) => a.position - b.position);
  const [first, second] = firstPositions;
  const optionNames = firstPositions.length === 2 && first?.position === 1 && second?.position === 2
    && first.name && second.name && first.name !== second.name ? [first.name, second.name] as const : null;
  const variants = product.variants.map(variant => {
    const option1 = optionNames ? optionValue(variant, optionNames[0]) : null;
    const option2 = optionNames ? optionValue(variant, optionNames[1]) : null;
    const suffix = option1 !== null && option2 !== null ? `-${option1}-${option2}` : null;
    return {
      id: variant.id,
      currentSku: variant.sku,
      expectedSku: base !== null && suffix !== null ? base + suffix : null,
      option1, option2,
      selectedOptions: variant.selectedOptions,
      status: classifySku(variant.sku, base, suffix),
    };
  });

  const counts: Record<VariantStatus, number> = {
    INITIAL: 0, TRANSFORMED: 0, DUPLICATE_TRANSFORMATION: 0, MISSING_SKU: 0, UNEXPECTED_SKU: 0,
    INVALID_OPTIONS: 0, UNVERIFIED_BASE: 0,
  };
  for (const variant of variants) counts[variant.status] += 1;

  const variantCount = variants.length;
  const duplicateVariantIds = duplicates(variants.map(variant => variant.id));
  const duplicateExpectedSkus = duplicates(variants.map(variant => variant.expectedSku));
  // Equal initial SKUs are by design until Hextom runs.
  const duplicateNonBaseSkus = base === null ? [] : duplicates(variants.map(variant =>
    variant.currentSku?.trim() && variant.currentSku !== base ? variant.currentSku : null));
  const issues: string[] = [];
  if (base === null) issues.push('MISSING_VERIFIED_BASE_SKU');
  if (!variantCount) issues.push('NO_VARIANTS');
  if (!optionNames) issues.push('INVALID_OPTION_POSITIONS');
  if (variants.some(variant => variant.option1 === null || variant.option2 === null)) issues.push('INVALID_VARIANT_OPTIONS');
  if (variants.some(variant => variant.id === null)) issues.push('MISSING_VARIANT_IDS');
  if (duplicateVariantIds.length) issues.push('DUPLICATE_VARIANT_IDS');
  if (duplicateExpectedSkus.length) issues.push('DUPLICATE_EXPECTED_SKUS');
  if (duplicateNonBaseSkus.length) issues.push('DUPLICATE_NON_BASE_SKUS');
  if (counts.MISSING_SKU) issues.push('MISSING_SKUS');
  if (counts.DUPLICATE_TRANSFORMATION) issues.push('DUPLICATE_TRANSFORMATIONS');
  if (counts.UNEXPECTED_SKU) issues.push('UNEXPECTED_SKUS');
  if (counts.TRANSFORMED > 0 && counts.TRANSFORMED < variantCount) issues.push('PARTIALLY_TRANSFORMED');
  if (variantCount > 0 && counts.INITIAL === variantCount && !hasAdjustTag) issues.push('INITIAL_SKUS_WITHOUT_ADJUST');

  let status: 'NEEDS_RECONCILIATION' | 'MANUAL_REVIEW' | 'VERIFIED_COMPLETE' | 'PENDING_HEXTOM' = 'MANUAL_REVIEW';
  if (base === null) status = 'NEEDS_RECONCILIATION';
  else if (issues.length === 0 && counts.TRANSFORMED === variantCount) status = 'VERIFIED_COMPLETE';
  else if (issues.length === 0 && counts.INITIAL === variantCount && hasAdjustTag) status = 'PENDING_HEXTOM';
  return {
    status, issues, productId: product.id, title: product.title, productStatus: product.status, updatedAt: product.updatedAt,
    tags: product.tags, hasAdjustTag, verifiedBaseSku: base, optionNames, variantCount, counts,
    duplicateVariantIds, duplicateExpectedSkus, duplicateNonBaseSkus, variants,
  };
}
