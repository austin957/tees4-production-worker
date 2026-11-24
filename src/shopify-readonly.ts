import { requiredText } from './config.js';
import { WorkerError } from './model.js';

const targetVersion = '2026-10';
const pageSize = 100;
const discoveryLimit = 5;
const maxTagPages = 250;
const attempts = 4;
const maxDelayMs = 30_000;

interface ShopifyConnectionConfig {
  domain: string;
  version: string;
  clientId: string;
  clientSecret: string;
}

export interface ShopifyReadConfig extends ShopifyConnectionConfig {
  shopId: string;
}

export function shopifyGid(value: unknown, kind: 'Shop' | 'Product' | 'ProductVariant'): string {
  if (typeof value !== 'string' || !new RegExp(`^gid://shopify/${kind}/[1-9][0-9]*$`).test(value)) {
    throw new WorkerError('INVALID_SHOPIFY_ID', `Supply an authoritative Shopify ${kind} GID.`);
  }
  return value;
}

export function shopifyIdentifyConfig(env: NodeJS.ProcessEnv): ShopifyConnectionConfig {
  const domain = requiredText(env.TEES4_SHOPIFY_DOMAIN, 'TEES4_SHOPIFY_DOMAIN');
  const version = env.TEES4_SHOPIFY_API_VERSION ?? targetVersion;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(domain) || !/^20\d{2}-(01|04|07|10)$/.test(version)) {
    throw new WorkerError('INVALID_SHOPIFY_CONFIG', 'Supply a canonical myshopify.com domain and a quarterly Shopify API version.');
  }
  return {
    domain, version,
    clientId: requiredText(env.TEES4_SHOPIFY_CLIENT_ID, 'TEES4_SHOPIFY_CLIENT_ID'),
    clientSecret: requiredText(env.TEES4_SHOPIFY_CLIENT_SECRET, 'TEES4_SHOPIFY_CLIENT_SECRET'),
  };
}

export function shopifyReadConfig(env: NodeJS.ProcessEnv): ShopifyReadConfig {
  return { ...shopifyIdentifyConfig(env), shopId: shopifyGid(env.TEES4_SHOPIFY_SHOP_ID, 'Shop') };
}

const shopQuery = `query Tees4ReadIdentity {
  shop { id myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
}`;

const productsQuery = `query Tees4ReadProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
    nodes { id title }
    pageInfo { hasNextPage endCursor }
  }
}`;

const adjustCandidatesQuery = `query Tees4ReadAdjustCandidates($first: Int!, $after: String, $search: String!) {
  products(first: $first, after: $after, query: $search, sortKey: ID) {
    nodes { id title status tags }
    pageInfo { hasNextPage endCursor }
  }
}`;

const productQuery = `query Tees4ReadProduct($id: ID!, $first: Int!, $after: String) {
  product(id: $id) {
    id title handle status vendor publishedAt tags
    options { id name optionValues { name } }
    variants(first: $first, after: $after) {
      nodes { id sku selectedOptions { name value } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const provenanceQuery = `query Tees4ReadProvenance($id: ID!) {
  product(id: $id) {
    id
    createdAt
    tags
    metafields(first: 25) {
      nodes { namespace key }
      pageInfo { hasNextPage }
    }
  }
}`;

const queries = {
  identity: shopQuery, products: productsQuery, adjustCandidates: adjustCandidatesQuery,
  product: productQuery, provenance: provenanceQuery,
};

export interface ProductSummary { id: string; title: string }
export interface TaggedProduct extends ProductSummary { status: string; tags: string[] }
export interface ShopIdentity { id: string; domain: string; scopes: string[]; apiVersion: string }
export interface ProductVariantRead {
  id: string | null;
  sku: string | null;
  selectedOptions: { name: string; value: string }[];
}
export interface ProductRead extends TaggedProduct {
  handle: string;
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

class ShopifyReadTransport {
  private grant?: { value: string; expiresAt: number };

  constructor(
    private readonly config: ShopifyConnectionConfig,
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

  async token(): Promise<string> {
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

  query(token: string, operation: keyof typeof queries, variables: Record<string, unknown>) {
    return this.request(`https://${this.config.domain}/admin/api/${this.config.version}/graphql.json`, {
      'Content-Type': 'application/json', 'X-Shopify-Access-Token': token,
    }, JSON.stringify({ query: queries[operation], variables }), true);
  }

  async readIdentity(token: string): Promise<ShopIdentity> {
    const data = await this.query(token, 'identity', {});
    const shop = record(data.shop);
    if (shop.myshopifyDomain !== this.config.domain) {
      throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The authenticated Shopify shop does not match the configured identity.');
    }
    if (data.currentAppInstallation === null) throw new WorkerError('SHOPIFY_PERMISSION', 'No Shopify app installation was returned.');
    const scopes = array(record(data.currentAppInstallation).accessScopes).map(scope => string(record(scope).handle));
    if (!scopes.includes('read_products') || scopes.some(scope => scope !== 'read_products')) {
      throw new WorkerError('SHOPIFY_PERMISSION', 'Use a dedicated Shopify app installation with only read_products.');
    }
    const id = shopifyGid(shop.id, 'Shop');
    return { id, domain: this.config.domain, apiVersion: this.config.version, scopes };
  }
}

export async function identifyShop(config: ShopifyConnectionConfig, fetcher?: typeof fetch): Promise<ShopIdentity> {
  const transport = new ShopifyReadTransport(config, fetcher);
  return transport.readIdentity(await transport.token());
}

export class ShopifyReadonlyClient {
  private readonly transport: ShopifyReadTransport;
  private readonly shopId: string;
  private verifiedToken: string | undefined;

  constructor(
    config: ShopifyReadConfig,
    fetcher?: typeof fetch,
    sleep?: (milliseconds: number) => Promise<void>,
    clock?: () => number,
  ) {
    this.shopId = shopifyGid(config.shopId, 'Shop');
    this.transport = new ShopifyReadTransport(config, fetcher, sleep, clock);
  }

  async verifyShop(): Promise<ShopIdentity> {
    return this.verifyToken(await this.transport.token());
  }

  private async verifyToken(token: string): Promise<ShopIdentity> {
    this.verifiedToken = undefined;
    const identity = await this.transport.readIdentity(token);
    if (identity.id !== this.shopId) {
      throw new WorkerError('SHOPIFY_SHOP_MISMATCH', 'The authenticated Shopify shop does not match the configured identity.');
    }
    this.verifiedToken = token;
    return identity;
  }

  private async verifiedQuery(operation: Exclude<keyof typeof queries, 'identity'>, variables: Record<string, unknown>) {
    const token = await this.transport.token();
    if (this.verifiedToken !== token) await this.verifyToken(token);
    return this.transport.query(token, operation, variables);
  }

  async recentProducts(): Promise<ProductSummary[]> {
    const products: ProductSummary[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < discoveryLimit && products.length < discoveryLimit; page += 1) {
      const first = discoveryLimit - products.length;
      const data = await this.verifiedQuery('products', { first, after });
      const connection = record(data.products);
      const nodes = array(connection.nodes);
      if (nodes.length > first) return invalidResponse();
      for (const value of nodes) {
        const node = record(value);
        const id = shopifyGid(node.id, 'Product');
        if (ids.has(id)) continue;
        ids.add(id);
        products.push({ id, title: string(node.title) });
      }
      if (products.length === discoveryLimit) break;
      const next = record(connection.pageInfo);
      if (next.hasNextPage === false) break;
      if (next.hasNextPage !== true || typeof next.endCursor !== 'string' || !next.endCursor || cursors.has(next.endCursor)) {
        throw new WorkerError('SHOPIFY_PAGINATION', 'Shopify returned an invalid or repeated product pagination cursor.');
      }
      cursors.add(next.endCursor);
      after = next.endCursor;
    }
    return products;
  }

  async adjustCandidates(): Promise<TaggedProduct[]> {
    const products = new Map<string, TaggedProduct>();
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < maxTagPages; page += 1) {
      const data = await this.verifiedQuery('adjustCandidates', { first: pageSize, after, search: 'tag:ADJUST' });
      const connection = record(data.products);
      for (const value of array(connection.nodes)) {
        const node = record(value);
        const id = shopifyGid(node.id, 'Product');
        products.set(id, { id, title: string(node.title), status: string(node.status), tags: array(node.tags).map(string) });
      }
      const next = record(connection.pageInfo);
      if (next.hasNextPage === false) return [...products.values()];
      if (next.hasNextPage !== true || typeof next.endCursor !== 'string' || !next.endCursor || cursors.has(next.endCursor)) {
        throw new WorkerError('SHOPIFY_PAGINATION', 'Shopify returned an invalid or repeated ADJUST search cursor.');
      }
      cursors.add(next.endCursor);
      after = next.endCursor;
    }
    throw new WorkerError('SHOPIFY_PAGINATION', 'The ADJUST search exceeded its page limit. No complete count is available.');
  }

  async productProvenance(id: string) {
    shopifyGid(id, 'Product');
    const data = await this.verifiedQuery('provenance', { id });
    const product = this.productRecord(data, id);
    const fields = record(product.metafields);
    const page = record(fields.pageInfo);
    if (typeof page.hasNextPage !== 'boolean') return invalidResponse();
    return {
      id,
      createdAt: string(product.createdAt),
      tags: array(product.tags).map(string),
      visibleMetafields: array(fields.nodes).map(value => {
        const field = record(value);
        return { namespace: string(field.namespace), key: string(field.key) };
      }),
      moreVisibleMetafields: page.hasNextPage,
    };
  }

  private productRecord(data: Record<string, unknown>, id: string) {
    if (data.product === null) {
      throw new WorkerError('SHOPIFY_PRODUCT_NOT_FOUND', 'The Shopify product was not found or is inaccessible to this installation.');
    }
    const product = record(data.product);
    if (product.id !== id) throw new WorkerError('SHOPIFY_PRODUCT_MISMATCH', 'Shopify returned a different product ID.');
    return product;
  }

  async product(id: string): Promise<ProductRead> {
    shopifyGid(id, 'Product');
    let result: ProductRead | undefined;
    let after: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      const data = await this.verifiedQuery('product', { id, first: pageSize, after });
      const product = this.productRecord(data, id);
      result ??= {
        id, title: string(product.title), handle: string(product.handle), vendor: string(product.vendor),
        status: string(product.status), publishedAt: nullableString(product.publishedAt), tags: array(product.tags).map(string),
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
