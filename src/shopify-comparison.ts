import { integer, object, onlyKeys, requiredText } from './config.js';
import { WorkerError } from './model.js';
import type { ProductionArtwork } from './model.js';
import { shopifyGid } from './shopify-readonly.js';
import type { ProductRead } from './shopify-readonly.js';
import type { ShopifyProductBinding } from './shopify-skus.js';

export interface ShopifyInspectionBinding extends ShopifyProductBinding {
  shopId: string;
  sourceRow: number;
  optionNames: { size: string; color: string };
  variants: { id: string; size: string | null; color: string | null }[];
}

function bindings(input: unknown): ShopifyInspectionBinding[] {
  if (!Array.isArray(input) || !input.length) throw new WorkerError('INVALID_SHOPIFY_BINDING', 'Supply a nonempty array of explicit Shopify bindings.');
  return (input as unknown[]).map(entry => {
    const value = object(entry, 'Shopify binding');
    onlyKeys(value, ['shopId', 'id', 'artworkSku', 'productSku', 'sourceRow', 'mockupifyExportRef', 'optionNames', 'variants'], 'Shopify binding');
    if (!Array.isArray(value.variants) || !value.variants.length) {
      throw new WorkerError('INVALID_SHOPIFY_BINDING', 'Supply all authoritative Shopify variant IDs and their expected options.');
    }
    const names = object(value.optionNames ?? { size: 'Size', color: 'Color' }, 'Shopify option names');
    onlyKeys(names, ['size', 'color'], 'Shopify option names');
    const optionNames = { size: requiredText(names.size, 'Size option name'), color: requiredText(names.color, 'Color option name') };
    if (optionNames.size === optionNames.color) {
      throw new WorkerError('INVALID_SHOPIFY_BINDING', 'Size and color option names must differ.');
    }
    return {
      shopId: shopifyGid(value.shopId, 'Shop'), id: shopifyGid(value.id, 'Product'),
      artworkSku: requiredText(value.artworkSku, 'Artwork SKU'), productSku: requiredText(value.productSku, 'Product SKU'),
      sourceRow: integer(value.sourceRow, 'Source row', 1, Number.MAX_SAFE_INTEGER),
      ...(value.mockupifyExportRef === undefined ? {} : {
        mockupifyExportRef: requiredText(value.mockupifyExportRef, 'Mockupify export reference'),
      }),
      optionNames,
      variants: (value.variants as unknown[]).map(entry => {
        const variant = object(entry, 'Bound variant');
        onlyKeys(variant, ['id', 'size', 'color'], 'Bound variant');
        return {
          id: shopifyGid(variant.id, 'ProductVariant'),
          size: variant.size === null ? null : requiredText(variant.size, 'Expected size'),
          color: variant.color === null ? null : requiredText(variant.color, 'Expected color'),
        };
      }),
    };
  });
}

export function selectShopifyBinding(input: unknown, shopId: string, sourceRow: number): ShopifyInspectionBinding {
  const scoped = bindings(input).filter(binding => binding.shopId === shopId);
  const matches = scoped.filter(binding => binding.sourceRow === sourceRow);
  if (!matches.length) throw new WorkerError('SHOPIFY_BINDING_NOT_FOUND', 'No explicit Shopify binding matches this shop and sheet row.');
  const binding = matches[0]!;
  const ids = new Set(binding.variants.map(variant => variant.id));
  if (matches.length !== 1 || ids.size !== binding.variants.length
    || scoped.some(candidate => candidate !== binding && (
      candidate.id === binding.id || candidate.productSku === binding.productSku || candidate.variants.some(variant => ids.has(variant.id))
    ))) {
    throw new WorkerError('AMBIGUOUS_SHOPIFY_BINDING', 'Conflicting product, variant, SKU or row bindings require review.');
  }
  return binding;
}

export function shopifyAssignment(artwork: ProductionArtwork, binding: ShopifyInspectionBinding) {
  const [garment] = artwork.garments.filter(garment => garment.sourceRow === binding.sourceRow);
  if (!garment || artwork.artworkSku !== binding.artworkSku || garment.productSku !== binding.productSku) {
    throw new WorkerError('SHOPIFY_BINDING_MISMATCH', 'The binding does not match the physical sheet row and both assigned SKUs.');
  }
  return { productSku: garment.productSku, colors: garment.colors.split(',').map(color => color.trim()) };
}

export function compareShopifyProduct(
  product: ProductRead, binding: ShopifyInspectionBinding, assignment: ReturnType<typeof shopifyAssignment>,
) {
  if (product.id !== binding.id || assignment.productSku !== binding.productSku) {
    throw new WorkerError('SHOPIFY_BINDING_MISMATCH', 'The returned product does not match the verified binding.');
  }
  const expected = new Map(binding.variants.map(variant => [variant.id, variant]));
  const observed = new Map<string, number>();
  const optionMismatches: { variantId: string; option: 'size' | 'color'; expected: string | null; actual: string[] }[] = [];
  const actualColors = new Set<string>();
  const blankVariantIds: string[] = [];
  const expectedSkuVariantIds: string[] = [];
  const unexpectedSkus: { variantId: string | null; sku: string }[] = [];
  let variantsWithoutId = 0;
  for (const variant of product.variants) {
    const { id, sku } = variant;
    if (id) observed.set(id, (observed.get(id) ?? 0) + 1);
    else variantsWithoutId++;
    if (sku === null || sku === '') {
      if (id) blankVariantIds.push(id);
    } else if (sku === assignment.productSku) {
      if (id) expectedSkuVariantIds.push(id);
    } else {
      unexpectedSkus.push({ variantId: id, sku });
    }
    for (const option of variant.selectedOptions) {
      if (option.name === binding.optionNames.color) actualColors.add(option.value);
    }
    const target = id ? expected.get(id) : undefined;
    if (!target) continue;
    for (const option of ['size', 'color'] as const) {
      const actual = variant.selectedOptions.filter(value => value.name === binding.optionNames[option]).map(value => value.value);
      if (target[option] === null ? actual.length !== 0 : actual.length !== 1 || actual[0] !== target[option]) {
        optionMismatches.push({ variantId: target.id, option, expected: target[option], actual });
      }
    }
  }
  const missingVariantIds = binding.variants.filter(variant => !observed.has(variant.id)).map(variant => variant.id);
  const duplicateVariantIds = [...observed].filter(([, count]) => count > 1).map(([id]) => id);
  const unboundVariantIds = [...observed.keys()].filter(id => !expected.has(id));
  const colorDifferences = binding.variants.some(variant => variant.color !== null) ? {
    missing: [...new Set(assignment.colors)].filter(color => !actualColors.has(color)),
    unexpected: [...actualColors].filter(color => !assignment.colors.includes(color)),
  } : { missing: [], unexpected: [] };
  const needsReview = Boolean(
    variantsWithoutId || missingVariantIds.length || duplicateVariantIds.length || unboundVariantIds.length
    || unexpectedSkus.length || optionMismatches.length || colorDifferences.missing.length || colorDifferences.unexpected.length,
  );
  return {
    binding: { shopId: binding.shopId, productId: binding.id, artworkSku: binding.artworkSku,
      sourceRow: binding.sourceRow, mockupifyExportRef: binding.mockupifyExportRef },
    expectedProductSku: assignment.productSku,
    product,
    publication: { productStatus: product.status, onlineStorePublishedAt: product.publishedAt },
    blankVariantIds, expectedSkuVariantIds, unexpectedSkus,
    variantsWithoutId, missingVariantIds, duplicateVariantIds, unboundVariantIds, optionMismatches, colorDifferences,
    status: needsReview ? 'needs_review' : blankVariantIds.length ? 'sku_assignment_required' : 'verified',
    proposedAssignments: needsReview ? [] : blankVariantIds.map(variantId => ({ variantId, sku: assignment.productSku })),
  };
}
