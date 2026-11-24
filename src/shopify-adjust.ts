import { adjustTag } from './shopify-readonly.js';
import type { ProductRead, ShopifyReadonlyClient, TaggedProduct } from './shopify-readonly.js';

type SkuPattern = 'uniform' | 'distinct' | 'blank_or_partial_blank' | 'anomalous';
type HextomCandidate = 'possible_pre_hextom' | 'possible_post_hextom' | 'undetermined';

function hasAdjustTag(product: TaggedProduct): boolean {
  return product.tags.includes(adjustTag);
}

export function summarizeAdjustProduct(product: ProductRead) {
  const counts = new Map<string, number>();
  const variantIds = new Set<string>();
  const duplicateVariantIds = new Set<string>();
  let blankSkuCount = 0;
  let whitespaceSkuCount = 0;
  let paddedSkuCount = 0;
  let missingVariantIdCount = 0;
  for (const { id, sku } of product.variants) {
    if (!id) missingVariantIdCount += 1;
    else if (variantIds.has(id)) duplicateVariantIds.add(id);
    else variantIds.add(id);
    if (sku === null || sku === '') {
      blankSkuCount += 1;
    } else {
      counts.set(sku, (counts.get(sku) ?? 0) + 1);
      const trimmed = sku.trim();
      if (trimmed === '') whitespaceSkuCount += 1;
      else if (trimmed !== sku) paddedSkuCount += 1;
    }
  }

  const variantCount = product.variants.length;
  const exactTag = hasAdjustTag(product);
  const values = [...counts].map(([value, count]) => ({ value, variantCount: count }));
  const anomalies: string[] = [];
  if (variantCount === 0) anomalies.push('no_variants');
  if (whitespaceSkuCount) anomalies.push('whitespace_only_skus');
  if (paddedSkuCount) anomalies.push('surrounding_sku_whitespace');
  if (missingVariantIdCount) anomalies.push('missing_variant_ids');
  if (duplicateVariantIds.size) anomalies.push('duplicate_variant_ids');
  if (counts.size > 1 && values.some(entry => entry.variantCount > 1)) anomalies.push('mixed_repeated_skus');

  let pattern: SkuPattern = 'anomalous';
  if (!anomalies.length) {
    if (blankSkuCount) pattern = 'blank_or_partial_blank';
    else pattern = counts.size === 1 ? 'uniform' : 'distinct';
  }

  let hextomCandidate: HextomCandidate = 'undetermined';
  if (exactTag && variantCount > 1) {
    if (pattern === 'uniform') hextomCandidate = 'possible_pre_hextom';
    if (pattern === 'distinct') hextomCandidate = 'possible_post_hextom';
  }

  return {
    id: product.id, title: product.title, status: product.status, tags: product.tags,
    createdAt: product.createdAt, updatedAt: product.updatedAt, options: product.options,
    hasAdjustTag: exactTag, variantCount, hextomCandidate,
    sku: {
      pattern, blankSkuCount, whitespaceSkuCount, paddedSkuCount, missingVariantIdCount, duplicateVariantIds: [...duplicateVariantIds],
      anomalies, values,
    },
  };
}

export async function discoverAdjustProducts(client: Pick<ShopifyReadonlyClient, 'adjustCandidates' | 'product'>) {
  const products: ReturnType<typeof summarizeAdjustProduct>[] = [];
  const withoutExactTag: TaggedProduct[] = [];
  const countsByPattern: Record<SkuPattern, number> = { uniform: 0, distinct: 0, blank_or_partial_blank: 0, anomalous: 0 };
  for (const candidate of await client.adjustCandidates()) {
    // The Shopify search can return case variants. Inspect the stored tags before loading variants.
    if (!hasAdjustTag(candidate)) {
      withoutExactTag.push(candidate);
      continue;
    }
    const product = await client.product(candidate.id);
    const report = summarizeAdjustProduct(product);
    if (report.hasAdjustTag) {
      products.push(report);
      countsByPattern[report.sku.pattern] += 1;
    } else {
      withoutExactTag.push({ id: product.id, title: product.title, status: product.status, tags: product.tags });
    }
  }
  return { tag: adjustTag, count: products.length, countsByPattern, products, withoutExactTag };
}
