import { WorkerError } from './model.js';

const origin = 'https://mockupify.io';
const pageSize = '500';
const maxPages = 1000;
const maxAttempts = 4;
const maxRetryDelay = 30_000;
type ListPath = '/api/batches/' | '/api/designs/' | '/api/products/' | '/api/exports/';
type ReadPath = ListPath | `/api/exports/${number}/`;

interface Batch { id: number; name: string; designsCount: number }
interface ProductRef { id: number; title: string }
interface Color { id: number; name: string; price: string; sizes: string[] }
interface Product extends ProductRef { type: string; library: boolean; colors: Color[] }
interface Design extends ProductRef { batchId: number | null; batchName: string; designReference: string | null; created: string }
interface ExportSummary {
  id: number;
  status: 'generating_images' | 'exporting' | 'finished' | 'failed';
  batch: Batch | null;
  created: string;
  images: { total: number; done: number };
}
interface ExportProduct {
  design: ProductRef & { designReference: string | null };
  product: ProductRef;
  colorIds: number[];
  status: 'pending' | 'created' | 'failed';
  shopifyProductId: string | null;
  shopifyProductGid: string | null;
}
interface ExportDetail extends ExportSummary {
  products: ExportProduct[];
  errors: { designId: number; productId: number; at: string }[];
}

function malformed(field: string): never {
  throw new WorkerError('MOCKUPIFY_INVALID_RESPONSE', `Unexpected Mockupify response for ${field}.`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed(field);
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) return malformed(field);
  return value;
}

function integer(value: unknown, field: string, min = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return malformed(field);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') return malformed(field);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  if (!Number.isFinite(Date.parse(result))) return malformed(field);
  return result;
}

function status<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) return malformed(field);
  return value as T;
}

function requestedId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new WorkerError('MOCKUPIFY_INVALID_ID', 'Supply a positive integer Mockupify ID.');
  }
  return id;
}

function parseBatch(value: unknown): Batch {
  const raw = record(value, 'batch');
  return {
    id: integer(raw.id, 'batch.id'),
    name: string(raw.name, 'batch.name'),
    designsCount: integer(raw.designs_count, 'batch.designs_count', 0),
  };
}

function parseRef(raw: Record<string, unknown>, field: string): ProductRef {
  return { id: integer(raw.id, `${field}.id`), title: string(raw.title, `${field}.title`) };
}

function parseDesign(value: unknown): Design {
  const raw = record(value, 'design');
  return {
    ...parseRef(raw, 'design'),
    batchId: raw.batch == null ? null : integer(raw.batch, 'design.batch'),
    batchName: string(raw.batch_name, 'design.batch_name'),
    designReference: raw.design_id == null ? null : string(raw.design_id, 'design.design_id'),
    created: timestamp(raw.created, 'design.created'),
  };
}

function parseProduct(value: unknown): Product {
  const raw = record(value, 'product');
  const ref = parseRef(raw, 'product');
  if (typeof raw.library !== 'boolean') return malformed('product.library');
  return {
    ...ref,
    type: string(raw.type, 'product.type'),
    library: raw.library,
    colors: array(raw.colors, 'product.colors').map(value => {
      const color = record(value, 'color');
      return {
        id: integer(color.id, 'color.id'),
        name: string(color.name, 'color.name'),
        price: string(color.price, 'color.price'),
        sizes: array(color.sizes, 'color.sizes').map(size => string(size, 'color.sizes entry')),
      };
    }),
  };
}

function parseExportSummary(raw: Record<string, unknown>): ExportSummary {
  const images = record(raw.images, 'export.images');
  return {
    id: integer(raw.id, 'export.id'),
    status: status(raw.status, ['generating_images', 'exporting', 'finished', 'failed'], 'export.status'),
    batch: raw.batch === null ? null : parseBatch(raw.batch),
    created: timestamp(raw.created, 'export.created'),
    images: {
      total: integer(images.total, 'export.images.total', 0),
      done: integer(images.done, 'export.images.done', 0),
    },
  };
}

function optionalShopifyId(value: unknown, pattern: RegExp, field: string): string | null {
  if (value == null) return null;
  const id = string(value, field);
  if (!pattern.test(id)) return malformed(field);
  return id;
}

function parseExportProduct(value: unknown): ExportProduct {
  const raw = record(value, 'export product');
  const design = record(raw.design, 'export product.design');
  const shopifyProductId = optionalShopifyId(raw.shopify_product_id, /^[1-9][0-9]*$/, 'export product.shopify_product_id');
  const shopifyProductGid = optionalShopifyId(raw.shopify_product_gid, /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/, 'export product.shopify_product_gid');
  if (shopifyProductId && shopifyProductGid && shopifyProductGid !== `gid://shopify/Product/${shopifyProductId}`) {
    return malformed('export product Shopify IDs');
  }
  return {
    design: {
      ...parseRef(design, 'export product.design'),
      designReference: design.design_id === null ? null : string(design.design_id, 'export product.design.design_id'),
    },
    product: parseRef(record(raw.product, 'export product.product'), 'export product.product'),
    colorIds: array(raw.colors, 'export product.colors').map(id => integer(id, 'export product color ID')),
    status: status(raw.status, ['pending', 'created', 'failed'], 'export product.status'),
    shopifyProductId,
    shopifyProductGid,
  };
}

function parseExportDetail(value: unknown): ExportDetail {
  const raw = record(value, 'export');
  return {
    ...parseExportSummary(raw),
    products: array(raw.products, 'export.products').map(parseExportProduct),
    errors: array(raw.errors, 'export.errors').map(value => {
      const error = record(value, 'export error');
      return {
        designId: integer(error.design, 'export error.design'),
        productId: integer(error.product, 'export error.product'),
        at: timestamp(error.at, 'export error.at'),
      };
    }),
  };
}

function validateNext(value: unknown, current: URL, nextPage: number): void {
  const next = URL.parse(string(value, 'pagination.next'), current);
  // Live links use HTTP. Validate their destination and reconstruct the request against the fixed HTTPS origin.
  if (!next || !['http:', 'https:'].includes(next.protocol) || next.hostname !== current.hostname ||
    next.port || next.username || next.password || next.hash || next.pathname !== current.pathname) {
    return malformed('pagination.next');
  }
  const expected = new URLSearchParams(current.searchParams);
  expected.set('page', String(nextPage));
  const actual = new URLSearchParams(next.searchParams);
  expected.sort();
  actual.sort();
  if (actual.toString() !== expected.toString()) return malformed('pagination.next');
}

function retryDelay(header: string | null, attempt: number): number {
  if (header && /^\d+$/.test(header)) return Number(header) * 1000;
  const date = header ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000 * 2 ** attempt;
}

export function mockupifyReadOnly(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
) {
  const key = env.TEES4_MOCKUPIFY_API_KEY;
  if (!key || !/^[\x21-\x7e]+$/.test(key)) {
    throw new WorkerError('MOCKUPIFY_MISSING_CREDENTIAL', 'Set TEES4_MOCKUPIFY_API_KEY to a valid bearer credential.');
  }

  async function read(path: ReadPath, query?: URLSearchParams): Promise<unknown> {
    const url = new URL(path, origin);
    if (query) url.search = query.toString();
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new WorkerError('MOCKUPIFY_CONNECTION_FAILED', 'The Mockupify HTTPS request failed.', true);
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch {
          return malformed('JSON');
        }
      }

      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        throw new WorkerError('MOCKUPIFY_AUTH_FAILED', `Mockupify rejected authentication or access (HTTP ${response.status}).`);
      }
      if (response.status === 429) {
        const delay = retryDelay(response.headers.get('retry-after'), attempt);
        if (attempt + 1 < maxAttempts && delay <= maxRetryDelay) {
          await sleep(delay);
          continue;
        }
        throw new WorkerError('MOCKUPIFY_RATE_LIMITED', 'Mockupify rate limited the request. Retry later.', true);
      }
      throw new WorkerError('MOCKUPIFY_HTTP_ERROR', `Mockupify returned HTTP ${response.status}.`, response.status >= 500);
    }
  }

  async function list<T>(path: ListPath, parse: (value: unknown) => T, batchId?: number): Promise<T[]> {
    const query = new URLSearchParams({ page_size: pageSize });
    if (batchId !== undefined) query.set('batch', String(requestedId(batchId)));
    const results: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) query.set('page', String(page));
      const raw = record(await read(path, query), 'pagination');
      const count = integer(raw.count, 'pagination.count', 0);
      const items = array(raw.results, 'pagination.results');
      for (const item of items) results.push(parse(item));
      if (raw.next === null || raw.next === undefined) {
        if (results.length < count) return malformed('pagination.next');
        return results;
      }
      if (items.length === 0) return malformed('pagination.results');
      const current = new URL(path, origin);
      current.search = query.toString();
      validateNext(raw.next, current, page + 1);
    }
    throw new WorkerError('MOCKUPIFY_PAGE_LIMIT', 'Mockupify pagination exceeded the supported page limit.');
  }

  return {
    listBatches: () => list('/api/batches/', parseBatch),
    listDesigns: (batchId?: number) => list('/api/designs/', parseDesign, batchId),
    listProducts: () => list('/api/products/', parseProduct),
    listExports: () => list('/api/exports/', value => parseExportSummary(record(value, 'export'))),
    async getExport(id: number) {
      const detail = parseExportDetail(await read(`/api/exports/${requestedId(id)}/`));
      if (detail.id !== id) return malformed('export.id');
      return detail;
    },
  };
}
