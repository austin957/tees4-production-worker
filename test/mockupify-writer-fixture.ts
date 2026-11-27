import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseApprovedMockupifyConfig } from '../src/mockupify-preparation.js';
import { previewMockupifyOperation, SupervisedMockupifyWriter } from '../src/mockupify-writer.js';
import { sha256 } from '../src/mockupify-writer-model.js';
import type { MockupifyOperation, MockupifyReview, SupervisedSourceRow } from '../src/mockupify-writer-model.js';
import type { Store } from '../src/store.js';

export const initialTime = Date.parse('2026-01-02T18:00:00Z');
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ZkAAAAASUVORK5CYII=', 'base64');
export const shop = { id: 'gid://shopify/Shop/7', domain: 'fixture.myshopify.com' };
export const productGid = 'gid://shopify/Product/9999';
export const review: MockupifyReview = {
  artworkRegistryName: 'Fixture artwork', designerAttribution: 'Designed by Fixture Designer',
  design: {
    title: 'Fixture title', description: 'Designed by Fixture Designer\nSecond line', extra_title: 'Sample',
    search_tags: 'test,audit', vendor: 'Fixture vendor', extra_price: '0.00',
  },
  shop: { ...shop, connectionEvidence: 'Fixture account settings' },
  product: {
    title: 'Fixture title Adult Tank Top Sample', descriptionHtml: '<p>Designed by Fixture Designer</p>',
    vendor: 'Fixture vendor', tags: ['test', 'audit', 'adjust'], status: 'ACTIVE',
    variants: [
      { options: { Color: 'Black', Size: 'M' }, price: '5.00' },
      { options: { Color: 'White', Size: 'M' }, price: '6.00' },
    ],
  },
  exclusiveBatchControlEvidence: 'Fixture operator lock',
  initialDescriptionEvidence: 'Fixture exact prior Shopify HTML record',
  publicationSafety: {
    evidence: 'Fixture verified interval before any eligible Hextom run', startsAt: initialTime - 60_000,
    endsAt: initialTime + 2 * 60 * 60_000, minimumMinutes: 15,
  },
};
const source: SupervisedSourceRow = {
  sourceRow: 9, sheetArtworkName: 'Fixture artwork', title: 'Fixture title', artworkSku: '000123',
  productSku: '000123-S105', garment: 'Adult Tank Top', rawColors: '50, 00', completion: null,
  description: 'Fixture description', vendor: 'Fixture vendor', tags: 'test,audit',
};
export const input = {
  source: {
    row: source.sourceRow, sheetArtworkName: source.sheetArtworkName, title: source.title, artworkSku: source.artworkSku,
    productSku: source.productSku, garment: source.garment, rawColors: source.rawColors, completion: null,
    evidence: 'fixture sheet row',
  },
  supplierColors: [
    { brand: 'Tultex', style: 'S105', code: '50', name: 'Black', mockupifyColorId: 11, evidence: 'fixture supplier record' },
    { brand: 'Tultex', style: 'S105', code: '00', name: 'White', mockupifyColorId: 12, evidence: 'fixture supplier record' },
  ],
  png: { originalRef: 'fixture original', originalSha256: sha256(png), preparedSha256: sha256(png) },
};
const { config } = parseApprovedMockupifyConfig(JSON.parse(readFileSync('config/mockupify-approved-v1.json', 'utf8')));
const catalog = config.mappings.map(mapping => ({
  id: mapping.templateId, title: mapping.templateTitle, type: mapping.templateType, library: false,
  colors: mapping.templateId === 10779 ? [
    { id: 11, name: 'Black', price: '5.00', sizes: ['M'] }, { id: 12, name: 'White', price: '6.00', sizes: ['M'] },
  ] : [],
}));
export const env = { TEES4_MOCKUPIFY_API_KEY: 'fixture-key' };

function page(results: unknown[]) {
  return Response.json({ results, count: results.length, next: null });
}

export class FakeMockupify {
  now = initialTime;
  rows = [structuredClone(source)];
  catalog = structuredClone(catalog);
  shop = { ...shop };
  shopifyReads: string[] = [];
  posts: string[] = [];
  requests: string[] = [];
  batches: { id: number; name: string; designs_count: number }[] = [{ id: 6100, name: 'Design Input', designs_count: 0 }];
  designs: { id: number; title: string; batch: number; batch_name: string; design_id: string; created: string }[] = [];
  exports: ReturnType<FakeMockupify['makeExport']>[] = [];
  afterPost?: (path: string, data: unknown) => Promise<void>;
  beforeRead?: (path: string) => void;
  responseOverride?: (path: string) => Response | undefined;
  productOverride: {
    status?: string; publishedAt?: string | null; vendor?: string; tags?: string[];
    hasSalesChannelPublication?: boolean; descriptionHtml?: string;
  } = {};
  includePublicationEvidence = true;
  verifyPublicationAccess: () => Promise<void> = async () => {};

  writer(store: Store, mode: 'simulate' | 'dry_run' | 'production' = 'simulate', exportMarginMinutes = 30) {
    return new SupervisedMockupifyWriter({
      store, env, shopify: {
        verifyShop: async () => ({ ...this.shop, scopes: ['read_products'], apiVersion: '2026-10' }),
        verifyExportPublicationAccess: () => this.verifyPublicationAccess(),
        productForExport: async id => {
          this.shopifyReads.push(id);
          assert.equal(id, productGid);
          return {
            id, title: review.product.title, descriptionHtml: review.product.descriptionHtml, vendor: review.product.vendor,
            status: 'ACTIVE', ...(this.includePublicationEvidence ? { hasSalesChannelPublication: false } : {}), tags: review.product.tags, handle: 'fixture', productType: '', publishedAt: null,
            createdAt: new Date(this.now).toISOString(), updatedAt: new Date(this.now).toISOString(), options: [],
            variants: review.product.variants.map((variant, index) => ({
              id: `gid://shopify/ProductVariant/${index + 8}`, sku: null, price: variant.price,
              selectedOptions: Object.entries(variant.options).map(([name, value]) => ({ name, value })),
            })),
            ...this.productOverride,
          };
        },
      },
      readSource: async () => structuredClone(this.rows), mode, simulationFetch: this.fetch,
      clock: () => this.now, sleep: async ms => { this.now += ms; }, exportMarginMinutes,
    });
  }

  approve(store: Store, id: string, operation: MockupifyOperation) {
    return { operation, digest: previewMockupifyOperation(store.getMockupifyJournal(id), operation).approvalDigest,
      by: 'Fixture owner', evidence: 'Fixture review for one operation', expiresAt: this.now + 3600_000 };
  }

  makeExport(batch: FakeMockupify['batches'][number], design: FakeMockupify['designs'][number], colors: number[]) {
    return {
      id: 301, batch: { ...batch }, created: new Date(this.now).toISOString(),
      status: 'generating_images', images: { total: 2, done: 0 },
      products: [{
        design: { id: design.id, title: design.title, design_id: design.design_id }, product: { id: 10779, title: 'Adult Tank Top' },
        colors, status: 'pending', shopify_product_id: null as string | null, shopify_product_gid: null as string | null,
      }],
      errors: [] as { design: number; product: number; at: string; message: string }[],
    };
  }

  finish(colors = [11, 12]) {
    const detail = this.exports[0]!;
    detail.status = 'finished';
    detail.images.done = 2;
    Object.assign(detail.products[0]!, {
      colors, status: 'created', shopify_product_id: '9999', shopify_product_gid: productGid,
    });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    this.requests.push(`${init?.method} ${path}`);
    assert.equal(url.origin, 'https://mockupify.invalid');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mockupify-simulation');
    if (init?.method === 'GET') {
      this.beforeRead?.(path);
      const override = this.responseOverride?.(path);
      if (override) return override;
      if (path === '/api/products/') return page(this.catalog);
      if (path === '/api/batches/') return page(this.batches);
      if (path === '/api/designs/') {
        const batch = url.searchParams.get('batch');
        return page(batch ? this.designs.filter(design => String(design.batch) === batch) : this.designs);
      }
      if (path === '/api/exports/') return page(this.exports.map(({ products: _p, errors: _e, ...summary }) => summary));
      if (/^\/api\/exports\/\d+\/$/.test(path)) return Response.json(this.exports.find(detail => path === `/api/exports/${detail.id}/`));
      throw new Error('unexpected GET');
    }

    assert.equal(init?.method, 'POST');
    this.posts.push(path);
    const override = this.responseOverride?.(path);
    if (override) return override;
    let data: unknown;
    if (path === '/api/batches/') {
      assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
      const { name } = JSON.parse(init.body as string) as { name: string };
      data = { id: 71, name, designs_count: 0 };
      this.batches.push(data as FakeMockupify['batches'][number]);
    } else if (path === '/api/designs/') {
      assert.ok(init.body instanceof Blob);
      const form = await new Response(init.body, { headers: new Headers(init.headers) }).formData();
      const file = form.get('file');
      assert.ok(file instanceof File);
      assert.equal(file.name, 'review.png');
      assert.equal(file.type, 'image/png');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
      const { file: _file, ...fields } = Object.fromEntries(form);
      for (const [key, value] of Object.entries(review.design)) assert.equal(fields[key], value);
      const batch = this.batches.find(item => String(item.id) === fields.batch)!;
      batch.designs_count++;
      data = { ...fields, id: 72, batch: batch.id, batch_name: batch.name, created: new Date(this.now).toISOString() };
      this.designs.push(data as FakeMockupify['designs'][number]);
    } else if (path === '/api/exports/') {
      assert.equal(this.requests.at(-2), 'GET /api/designs/');
      const body = JSON.parse(init.body as string) as { batch: number; colors: number[] };
      assert.deepEqual(body, { batch: 71, colors: [11, 12] });
      data = this.makeExport(this.batches[1]!, this.designs[0]!, body.colors);
      this.exports.push(data as FakeMockupify['exports'][number]);
    } else {
      throw new Error('unexpected POST');
    }
    await this.afterPost?.(path, data);
    return Response.json(data, { status: path === '/api/exports/' ? 202 : 201 });
  };
}

export async function prepare(store: Store, api: FakeMockupify) {
  const writer = api.writer(store);
  const journal = await writer.prepare(input, review, png);
  return journal.plan.correlation.correlationId;
}

export async function readyToExport(store: Store, api: FakeMockupify) {
  const id = await prepare(store, api);
  const writer = api.writer(store);
  const batch = await writer.dispatch(id, 'create_batch', api.approve(store, id, 'create_batch'));
  assert.equal(batch.batchId, 71);
  const design = await writer.dispatch(id, 'upload_design', api.approve(store, id, 'upload_design'), png);
  assert.equal(design.designId, 72);
  return id;
}
