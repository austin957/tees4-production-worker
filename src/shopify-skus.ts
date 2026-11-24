import { integer, object, onlyKeys, requiredText } from './config.js';
import { WorkerError } from './model.js';
import { assertSkuWindow } from './production-schedule.js';
import type { Mode, ProductionArtwork, StageResult } from './model.js';

export interface ShopifyVariant {
  id: string;
  size: string;
  color: string;
  sku: string | null;
}

export interface ShopifyProductBinding {
  id: string;
  artworkSku: string;
  productSku: string;
  mockupifyExportRef?: string;
  sourceRow?: number;
}

export interface ShopifyProduct extends ShopifyProductBinding {
  variants: ShopifyVariant[];
}

export type InitialSkuTarget = {
  productId: string;
  artworkSku: string;
  productSku: string;
  variantId: string;
};

type Assignment = NonNullable<StageResult['skuAssignments']>[number];
type ExistingSkuResult = { outcome: 'already_assigned' } | { outcome: 'preserved'; review: NonNullable<Assignment['review']> };
type AssignmentResult = ExistingSkuResult | { outcome: 'assigned' };

export interface ShopifySkuAdapter {
  findProducts(productSku: string): Promise<readonly ShopifyProduct[]>;
  // Implementations must recheck product binding, SKU state and the protected window at mutation time.
  assignInitialSku(target: InitialSkuTarget, clock: () => number): Promise<AssignmentResult>;
}

export function parseShopifyCatalog(input: unknown): ShopifyProduct[] {
  if (!Array.isArray(input) || !input.length) throw new WorkerError('INVALID_CATALOG', 'Supply one or more Shopify fixture products.');
  const productIds = new Set<string>();
  const variantIds = new Set<string>();
  return input.map((entry: unknown) => {
    const raw = object(entry, 'Shopify product');
    onlyKeys(raw, ['id', 'artworkSku', 'productSku', 'mockupifyExportRef', 'sourceRow', 'variants'], 'Shopify product');
    const id = requiredText(raw.id, 'Shopify product ID');
    if (productIds.has(id)) throw new WorkerError('DUPLICATE_ID', 'Shopify product IDs must be unique.');
    productIds.add(id);
    if (!Array.isArray(raw.variants) || !raw.variants.length) {
      throw new WorkerError('INVALID_CATALOG', 'Each Shopify product requires one or more size/color variants.');
    }
    const options = new Set<string>();
    const variants = raw.variants.map((entry: unknown): ShopifyVariant => {
      const row = object(entry, 'Shopify variant');
      onlyKeys(row, ['id', 'size', 'color', 'sku'], 'Shopify variant');
      const variant = {
        id: requiredText(row.id, 'Shopify variant ID'),
        size: requiredText(row.size, 'Variant size'),
        color: requiredText(row.color, 'Variant color'),
        sku: row.sku === null || row.sku === '' ? null : requiredText(row.sku, 'Variant SKU'),
      };
      if (variantIds.has(variant.id)) throw new WorkerError('DUPLICATE_ID', 'Shopify variant IDs must be unique.');
      variantIds.add(variant.id);
      const key = JSON.stringify([variant.size, variant.color]);
      if (options.has(key)) throw new WorkerError('DUPLICATE_VARIANT_OPTIONS', 'A product repeats a size/color combination.');
      options.add(key);
      return variant;
    });
    return {
      id,
      artworkSku: requiredText(raw.artworkSku, 'Product Artwork SKU'),
      productSku: requiredText(raw.productSku, 'Product SKU binding'),
      ...(raw.mockupifyExportRef === undefined ? {} : {
        mockupifyExportRef: requiredText(raw.mockupifyExportRef, 'Mockupify export reference'),
      }),
      ...(raw.sourceRow === undefined ? {} : {
        sourceRow: integer(raw.sourceRow, 'Shopify binding source row', 1, Number.MAX_SAFE_INTEGER),
      }),
      variants: variants.sort((left, right) => left.id < right.id ? -1 : Number(left.id > right.id)),
    };
  });
}

export function resolveProduct<T extends Pick<ShopifyProduct, 'artworkSku'>>(candidates: readonly T[], artworkSku: string): T {
  if (candidates.length > 1) throw new WorkerError('AMBIGUOUS_PRODUCT', 'More than one Shopify product is bound to an assigned Product SKU.');
  const [product] = candidates;
  if (!product) throw new WorkerError('PRODUCT_NOT_FOUND', 'No Shopify product is bound to an assigned Product SKU.');
  if (product.artworkSku !== artworkSku) {
    throw new WorkerError('PRODUCT_BINDING_CONFLICT', 'The Shopify product binding belongs to another Artwork SKU.');
  }
  return product;
}

export function existingSku(sku: string | null, expected: string): ExistingSkuResult | undefined {
  if (sku === null) return undefined;
  return sku === expected
    ? { outcome: 'already_assigned' }
    : { outcome: 'preserved', review: { code: 'UNEXPECTED_VARIANT_SKU', observedSku: sku } };
}

export async function assignSkus(
  artwork: ProductionArtwork, mode: Mode, adapter: ShopifySkuAdapter, clock: () => number, expectedProductId?: string,
): Promise<Assignment[]> {
  // Resolve all garment bindings before the first write so a known ambiguity cannot cause partial writes.
  const products: ShopifyProduct[] = [];
  for (const garment of artwork.garments) {
    const product = resolveProduct(await adapter.findProducts(garment.productSku), artwork.artworkSku);
    if (product.productSku !== garment.productSku || (expectedProductId !== undefined && product.id !== expectedProductId)
      || products.some(previous => previous.id === product.id)) {
      throw new WorkerError('PRODUCT_BINDING_CONFLICT', 'The Shopify product binding does not uniquely match the garment assignment.');
    }
    products.push(product);
  }
  if (mode === 'simulate' && products.some(product => product.variants.some(variant => variant.sku === null))) {
    assertSkuWindow(clock());
  }

  const assignments: Assignment[] = [];
  for (const product of products) {
    for (const variant of product.variants) {
      const target = { productId: product.id, artworkSku: artwork.artworkSku, productSku: product.productSku, variantId: variant.id };
      const result = mode === 'dry-run'
        ? existingSku(variant.sku, product.productSku) ?? { outcome: 'planned' as const }
        : await adapter.assignInitialSku(target, clock);
      assignments.push({
        productId: target.productId, productSku: target.productSku, variantId: target.variantId,
        size: variant.size, color: variant.color, ...result,
      });
    }
  }
  return assignments;
}
