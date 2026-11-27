import { WorkerError } from './model.js';
import type { ShopIdentity } from './shopify-readonly.js';

export const skuWriteScope = 'write_products';

const mutation = `mutation Tees4ReplaceVariantSkus($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    product { id }
    productVariants { id sku }
    userErrors { code field message }
  }
}`;

export function skuBulkUpdateRequest(productId: string, variants: readonly { variantId: string; targetSku: string }[]) {
  // GraphQL list inputs are limited to 250 entries. Use a single synchronous mutation.
  if (variants.length < 1 || variants.length > 250) {
    throw new WorkerError('SKU_REPLACEMENT_BATCH_SIZE', 'The full variant set must fit in one Shopify mutation.');
  }
  return {
    query: mutation,
    variables: { productId, variants: variants.map(({ variantId, targetSku }) => ({
      id: variantId, inventoryItem: { sku: targetSku },
    })) },
  };
}

export interface SkuBulkResponse {
  requestId?: string;
  httpStatus?: number;
  graphqlErrorCodes?: readonly string[];
  productId?: string | null;
  variants?: readonly { id: string; sku: string | null }[] | null;
  userErrors?: readonly { code: string | null; field: readonly string[] | null; message: string }[];
}

// Phase 22B supplies this interface only to simulations. No authenticated write transport is wired.
export interface SimulatedSkuWriter {
  verifyShop(): Promise<Pick<ShopIdentity, 'id' | 'scopes'>>;
  hextomPaused(productId: string): boolean;
  updateSkus(request: ReturnType<typeof skuBulkUpdateRequest>): Promise<SkuBulkResponse>;
}
