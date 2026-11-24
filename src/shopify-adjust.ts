import type { ProductRead, ShopifyReadonlyClient, TaggedProduct } from './shopify-readonly.js';

const adjustTag = 'ADJUST';

function hasAdjustTag(product: TaggedProduct): boolean {
  return product.tags.includes(adjustTag);
}

export function summarizeAdjustProduct(product: ProductRead) {
  const counts = new Map<string, number>();
  const variantIds = new Set<string>();
  const duplicateVariantIds = new Set<string>();
  let blankSkuCount = 0;
  let whitespaceSkuCount = 0;
  let missingVariantIdCount = 0;
  for (const { id, sku } of product.variants) {
    if (!id) missingVariantIdCount += 1;
    else if (variantIds.has(id)) duplicateVariantIds.add(id);
    else variantIds.add(id);
    if (sku === null || sku === '') {
      blankSkuCount += 1;
    } else {
      counts.set(sku, (counts.get(sku) ?? 0) + 1);
      if (sku.trim() === '') whitespaceSkuCount += 1;
    }
  }
  const incomplete = !product.variants.length || Boolean(blankSkuCount || whitespaceSkuCount || missingVariantIdCount);
  const conflicting = counts.size > 1 || duplicateVariantIds.size > 0;
  return {
    id: product.id, title: product.title, status: product.status, tags: product.tags,
    hasAdjustTag: hasAdjustTag(product),
    variantCount: product.variants.length,
    sku: {
      status: incomplete && conflicting ? 'incomplete_and_conflicting' : incomplete ? 'incomplete' : conflicting ? 'conflicting' : 'consistent',
      blankSkuCount, whitespaceSkuCount, missingVariantIdCount, duplicateVariantIds: [...duplicateVariantIds],
      values: [...counts].map(([value, variantCount]) => ({ value, variantCount })),
    },
  };
}

export async function discoverAdjustProducts(client: Pick<ShopifyReadonlyClient, 'adjustCandidates' | 'product'>) {
  const products: ReturnType<typeof summarizeAdjustProduct>[] = [];
  const withoutExactTag: TaggedProduct[] = [];
  for (const candidate of await client.adjustCandidates()) {
    // Shopify search can return case variants. Inspect the stored tags before loading variants.
    if (!hasAdjustTag(candidate)) {
      withoutExactTag.push(candidate);
      continue;
    }
    const product = await client.product(candidate.id);
    const report = summarizeAdjustProduct(product);
    if (report.hasAdjustTag) products.push(report);
    else withoutExactTag.push({ id: product.id, title: product.title, status: product.status, tags: product.tags });
  }
  return { tag: adjustTag, count: products.length, products, withoutExactTag };
}
