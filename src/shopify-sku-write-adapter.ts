import { object, requiredText } from './config.js';
import { authorizeShopifySkuWriter, shopifyReadConfig } from './shopify-readonly.js';
import { WorkerError } from './model.js';
import type { ShopIdentity } from './shopify-readonly.js';

export const skuWriteScope = 'write_products';
export const mutationTimeoutMs = 15_000;

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

export interface SkuWriter {
  verifyShop(): Promise<Pick<ShopIdentity, 'id' | 'scopes'> & { installationId?: string }>;
  updateSkus(request: ReturnType<typeof skuBulkUpdateRequest>): Promise<SkuBulkResponse>;
}

export interface SimulatedSkuWriter extends SkuWriter {
  hextomPaused(productId: string): boolean;
}

export function shopifySkuWriter(env: NodeJS.ProcessEnv, fetcher = fetch, clock = Date.now): SkuWriter {
  const reader = shopifyReadConfig(env);
  const config = shopifyReadConfig({
    ...env,
    TEES4_SHOPIFY_CLIENT_ID: env.TEES4_SHOPIFY_SKU_WRITE_CLIENT_ID,
    TEES4_SHOPIFY_CLIENT_SECRET: env.TEES4_SHOPIFY_SKU_WRITE_CLIENT_SECRET,
  });
  const installationId = requiredText(env.TEES4_SHOPIFY_SKU_WRITE_INSTALLATION_ID, 'SKU writer app installation GID');
  const sameClientId = reader.clientId === config.clientId;
  const sameClientSecret = reader.clientSecret === config.clientSecret;
  const allowSingleApp = env.TEES4_SHOPIFY_SKU_WRITE_ALLOW_SINGLE_APP === 'true';
  if ((sameClientId || sameClientSecret) && !(allowSingleApp && sameClientId && sameClientSecret)) {
    throw new WorkerError('SKU_EXECUTION_INSTALLATION_UNAUTHORIZED',
      'Use distinct writer credentials or enable TEES4_SHOPIFY_SKU_WRITE_ALLOW_SINGLE_APP=true with a fully matching credential pair.');
  }
  if (!/^gid:\/\/shopify\/AppInstallation\/[1-9][0-9]*$/.test(installationId)) {
    throw new WorkerError('SKU_EXECUTION_INSTALLATION_UNAUTHORIZED', 'Configure the authorized SKU writer app installation GID.');
  }
  let grant: Awaited<ReturnType<typeof authorizeShopifySkuWriter>> | undefined;
  return {
    async verifyShop() {
      grant = undefined;
      const verified = await authorizeShopifySkuWriter(config, installationId, skuWriteScope, fetcher, clock);
      grant = verified;
      return { id: verified.id, scopes: verified.scopes, installationId };
    },
    async updateSkus(request) {
      const authorized = grant;
      grant = undefined;
      if (!authorized || authorized.expiresAt <= clock() + mutationTimeoutMs) {
        throw new WorkerError('SKU_EXECUTION_INSTALLATION_UNAUTHORIZED', 'The verified Shopify writer credential is unavailable or expires too soon.');
      }
      const fixedRequest = skuBulkUpdateRequest(request.variables.productId, request.variables.variants.map(variant => ({
        variantId: variant.id, targetSku: variant.inventoryItem.sku,
      })));
      const response = await fetcher(`https://${config.domain}/admin/api/${config.version}/graphql.json`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(mutationTimeoutMs),
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': authorized.token },
        body: JSON.stringify(fixedRequest),
      });
      const requestId = response.headers.get('X-Request-ID');
      const metadata = { httpStatus: response.status, ...(requestId && /^[a-zA-Z0-9-]{1,128}$/.test(requestId) ? { requestId } : {}) };
      if (!response.ok || response.headers.get('X-Shopify-API-Version') !== config.version) {
        await response.body?.cancel().catch(() => {});
        return { ...metadata, graphqlErrorCodes: [response.ok ? 'SHOPIFY_VERSION' : 'SHOPIFY_HTTP_ERROR'] };
      }
      try {
        return { ...metadata, ...parseMutationResponse(await response.json()) };
      } catch {
        return { ...metadata, graphqlErrorCodes: ['SHOPIFY_RESPONSE_UNCERTAIN'] };
      }
    },
  };
}

function responseList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a Shopify list.');
  return value;
}

function responseText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected Shopify response text.');
  return value;
}

function safeCode(value: unknown, fallback: string) {
  return typeof value === 'string' && /^[A-Z_0-9]{1,64}$/.test(value) ? value : fallback;
}

function parseMutationResponse(value: unknown): SkuBulkResponse {
  const body = object(value, 'Shopify response');
  if (body.errors !== undefined) {
    const errors = responseList(body.errors);
    if (errors.length) return { graphqlErrorCodes: errors.map(value => {
      const error = object(value, 'Shopify error');
      const extensions = error.extensions == null ? {} : object(error.extensions, 'Shopify error extensions');
      return safeCode(extensions.code, 'SHOPIFY_GRAPHQL_ERROR');
    }) };
  }
  const data = object(body.data, 'Shopify mutation data');
  const payload = object(data.productVariantsBulkUpdate, 'Shopify mutation payload');
  return {
    productId: payload.product === null ? null : responseText(object(payload.product, 'Shopify product').id),
    variants: payload.productVariants === null ? null : responseList(payload.productVariants).map(value => {
      const variant = object(value, 'Shopify variant');
      return { id: responseText(variant.id), sku: variant.sku === null ? null : responseText(variant.sku) };
    }),
    userErrors: responseList(payload.userErrors).map(value => {
      const error = object(value, 'Shopify user error');
      return { code: error.code === null ? null : safeCode(error.code, 'SHOPIFY_USER_ERROR'),
        field: error.field === null ? null : responseList(error.field).map(value =>
          typeof value === 'string' && /^(?:variants|inventoryItem|sku|id|productId|[0-9]{1,3})$/.test(value) ? value : 'unknown'),
        message: 'Shopify reported a variant update error.' };
    }),
  };
}
