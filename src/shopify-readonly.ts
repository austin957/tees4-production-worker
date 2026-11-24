import { requiredText } from './config.js';
import { WorkerError } from './model.js';

const targetVersion = '2026-10';
const pageSize = 100;
const attempts = 4;
const maxDelayMs = 30_000;

export interface ShopifyReadConfig {
  domain: string;
  shopId: string;
  version: string;
  clientId: string;
  clientSecret: string;
}

export function shopifyGid(value: unknown, kind: 'Shop' | 'Product' | 'ProductVariant'): string {
  if (typeof value !== 'string' || !new RegExp(`^gid://shopify/${kind}/[1-9][0-9]*$`).test(value)) {
    throw new WorkerError('INVALID_SHOPIFY_ID', `Supply an authoritative Shopify ${kind} GID.`);
  }
  return value;
}

export function shopifyReadConfig(env: NodeJS.ProcessEnv): ShopifyReadConfig {
  const domain = requiredText(env.TEES4_SHOPIFY_DOMAIN, 'TEES4_SHOPIFY_DOMAIN');
  const version = env.TEES4_SHOPIFY_API_VERSION ?? targetVersion;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(domain) || !/^20\d{2}-(01|04|07|10)$/.test(version)) {
    throw new WorkerError('INVALID_SHOPIFY_CONFIG', 'Supply a canonical myshopify.com domain and a quarterly Shopify API version.');
  }
  return {
    domain, version,
    shopId: shopifyGid(env.TEES4_SHOPIFY_SHOP_ID, 'Shop'),
    clientId: requiredText(env.TEES4_SHOPIFY_CLIENT_ID, 'TEES4_SHOPIFY_CLIENT_ID'),
    clientSecret: requiredText(env.TEES4_SHOPIFY_CLIENT_SECRET, 'TEES4_SHOPIFY_CLIENT_SECRET'),
  };
}

const shopQuery = `query Tees4ReadIdentity {
  shop { id myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
}`;

const productQuery = `query Tees4ReadProduct($id: ID!, $first: Int!, $after: String) {
  product(id: $id) {
    id title handle status vendor publishedAt
    options { id name optionValues { name } }
    variants(first: $first, after: $after) {
      nodes { id sku selectedOptions { name value } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export interface ShopIdentity { id: string; domain: string; scopes: string[]; apiVersion: string }
export interface ProductVariantRead {
  id: string | null;
  sku: string | null;
  selectedOptions: { name: string; value: string }[];
}
export interface ProductRead {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  publishedAt: string | null;
  options: { id: string; name: string; values: string[] }[];
  variants: ProductVariantRead[];
}

function invalidResponse(): never {
  throw new WorkerError('SHOPIFY_RESPONSE', 'Shopify returned an unexpected response.');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidResponse();
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') return invalidResponse();
  return value;
}
function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function retryAfter(header: string | null, now: number): number {
  if (header === null) return 0;
  if (/^\d+(?:\.\d+)?$/.test(header)) return Math.ceil(Number(header) * 1000);
  const time = Date.parse(header);
  return Number.isFinite(time) ? Math.max(time - now, 0) : 0;
}

function throttleDelay(body: Record<string, unknown>): number {
  const extensions = body.extensions as { cost?: {
    requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number };
  } } | undefined;
  const cost = extensions?.cost;
  const limit = cost?.throttleStatus;
  if (typeof cost?.requestedQueryCost !== 'number' || typeof limit?.currentlyAvailable !== 'number'
    || typeof limit.restoreRate !== 'number' || limit.restoreRate <= 0) return 0;
  return Math.max(0, Math.ceil((cost.requestedQueryCost - limit.currentlyAvailable) * 1000 / limit.restoreRate));
}

export class ShopifyReadonlyClient {
  private grant?: { value: string; expiresAt: number };
  private verifiedToken: string | undefined;

  constructor(
    private readonly config: ShopifyReadConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly clock: () => number = Date.now,
  ) {}

  private async request(
    url: string, headers: Record<string, string>, body: string, graphql: boolean,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let delay = 250 * 2 ** attempt;
      let code = 'SHOPIFY_TRANSIENT';
      let response: Response | undefined;
      try {
        response = await this.fetcher(url, {
          method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000),
        });
      } catch {
        // Fetch errors may contain headers or URLs. Report only stable error codes.
      }
      if (response) {
        if (response.status === 401) throw new WorkerError('SHOPIFY_AUTH', 'Shopify rejected the credentials or token.');
        if (response.status === 403) throw new WorkerError('SHOPIFY_PERMISSION', 'Shopify denied access. Verify the installation and read_products permission.');
        if (response.status === 429 || response.status === 408 || response.status >= 500) {
          code = response.status === 429 ? 'SHOPIFY_THROTTLED' : code;
          delay = Math.max(delay, retryAfter(response.headers.get('Retry-After'), this.clock()));
        } else {
          if (!response.ok) throw new WorkerError(
            graphql ? 'SHOPIFY_REQUEST' : 'SHOPIFY_AUTH',
            graphql ? 'Shopify rejected the GraphQL request.' : 'Shopify rejected the client credentials grant.',
          );
          let raw: string | undefined;
          try { raw = await response.text(); } catch { /* a response body can be interrupted */ }
          if (raw !== undefined) {
            let data: Record<string, unknown>;
            try { data = record(JSON.parse(raw)); } catch { return invalidResponse(); }
            if (!graphql) return data;
            if (response.headers.get('X-Shopify-API-Version') !== this.config.version) {
              throw new WorkerError('SHOPIFY_VERSION', 'Shopify did not return the configured API version. Verify version support before continuing.');
            }
            const errors = data.errors === undefined ? [] : array(data.errors).map(error => record(error));
            if (!errors.length) return record(data.data);
            const codes = errors.map(error => (error.extensions as { code?: string } | undefined)?.code);
            if (codes.includes('ACCESS_DENIED')) {
              throw new WorkerError('SHOPIFY_PERMISSION', 'The app cannot read the requested Shopify resource.');
            }
            if (codes.every(value => value === 'THROTTLED' || value === 'INTERNAL_SERVER_ERROR')) {
              if (codes.includes('THROTTLED')) {
                code = 'SHOPIFY_THROTTLED';
                delay = Math.max(delay, throttleDelay(data), retryAfter(response.headers.get('Retry-After'), this.clock()));
              }
            } else {
              throw new WorkerError('SHOPIFY_GRAPHQL', 'Shopify rejected the read-only GraphQL query.');
            }
          }
        }
        if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
      }
      if (attempt === attempts - 1 || delay > maxDelayMs) {
        throw new WorkerError(code, 'Shopify read could not complete within the retry budget.');
      }
      await this.sleep(delay);
    }
    return invalidResponse();
  }

  private async token(): Promise<string> {
    if (this.grant && this.grant.expiresAt - this.clock() > 60_000) return this.grant.value;
    const grant = await this.request(`https://${this.config.domain}/admin/oauth/access_token`, {
      'Content-Type': 'application/x-www-form-urlencoded',
    }, new URLSearchParams({
      grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret,
    }).toString(), false);
    const value = string(grant.access_token);
    if (!value || typeof grant.expires_in !== 'number' || !Number.isFinite(grant.expires_in) || grant.expires_in <= 0) {
      return invalidResponse();
    }
    this.grant = { value, expiresAt: this.clock() + grant.expires_in * 1000 };
    return value;
  }

  private query(token: string, operation: 'identity' | 'product', variables: Record<string, unknown>) {
    return this.request(`https://${this.config.domain}/admin/api/${this.config.version}/graphql.json`, {
      'Content-Type': 'application/json', 'X-Shopify-Access-Token': token,
    }, JSON.stringify({ query: operation === 'identity' ? shopQuery : productQuery, variables }), true);
  }

  async verifyShop(): Promise<ShopIdentity> {
    return this.verifyToken(await this.token());
  }

  private async verifyToken(token: string): Promise<ShopIdentity> {
    const data = await this.query(token, 'identity', {});
    const shop = record(data.shop);
    if (shop.id !== this.config.shopId || shop.myshopifyDomain !== this.config.domain) {
      throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The authenticated Shopify shop does not match the configured identity.');
    }
    if (data.currentAppInstallation === null) throw new WorkerError('SHOPIFY_PERMISSION', 'No Shopify app installation was returned.');
    const scopes = array(record(data.currentAppInstallation).accessScopes).map(scope => string(record(scope).handle));
    if (!scopes.includes('read_products') || scopes.some(scope => scope !== 'read_products')) {
      throw new WorkerError('SHOPIFY_PERMISSION', 'Use a dedicated Shopify app installation with only read_products.');
    }
    this.verifiedToken = token;
    return { id: this.config.shopId, domain: this.config.domain, apiVersion: this.config.version, scopes };
  }

  async product(id: string): Promise<ProductRead> {
    shopifyGid(id, 'Product');
    let result: ProductRead | undefined;
    let after: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      const token = await this.token();
      if (this.verifiedToken !== token) await this.verifyToken(token);
      const data = await this.query(token, 'product', { id, first: pageSize, after });
      if (data.product === null) {
        throw new WorkerError('SHOPIFY_PRODUCT_NOT_FOUND', 'The Shopify product was not found or is inaccessible to this installation.');
      }
      const product = record(data.product);
      if (product.id !== id) throw new WorkerError('SHOPIFY_PRODUCT_MISMATCH', 'Shopify returned a different product ID.');
      result ??= {
        id, title: string(product.title), handle: string(product.handle), vendor: string(product.vendor),
        status: string(product.status), publishedAt: nullableString(product.publishedAt),
        options: array(product.options).map(value => {
          const option = record(value);
          return { id: string(option.id), name: string(option.name), values: array(option.optionValues).map(item => string(record(item).name)) };
        }),
        variants: [],
      };
      const connection = record(product.variants);
      for (const value of array(connection.nodes)) {
        const variant = record(value);
        result.variants.push({
          id: variant.id === undefined || variant.id === null || variant.id === '' ? null : shopifyGid(variant.id, 'ProductVariant'),
          sku: nullableString(variant.sku),
          selectedOptions: array(variant.selectedOptions).map(item => {
            const option = record(item);
            return { name: string(option.name), value: string(option.value) };
          }),
        });
      }
      const page = record(connection.pageInfo);
      if (page.hasNextPage === false) return result;
      if (page.hasNextPage !== true || typeof page.endCursor !== 'string' || !page.endCursor || cursors.has(page.endCursor)) {
        throw new WorkerError('SHOPIFY_PAGINATION', 'Shopify returned an invalid or repeated variant pagination cursor.');
      }
      cursors.add(page.endCursor);
      after = page.endCursor;
    }
  }
}
