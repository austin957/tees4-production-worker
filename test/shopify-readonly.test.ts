import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readJson } from '../src/config.js';
import { readProductionArtwork, simulatedSheets } from '../src/sheets.js';
import { compareShopifyProduct, selectShopifyBinding, shopifyAssignment } from '../src/shopify-comparison.js';
import { shopifyReadConfig, ShopifyReadonlyClient } from '../src/shopify-readonly.js';
import type { ProductRead } from '../src/shopify-readonly.js';

const env = {
  TEES4_SHOPIFY_DOMAIN: 'fixture.myshopify.com',
  TEES4_SHOPIFY_SHOP_ID: 'gid://shopify/Shop/1',
  TEES4_SHOPIFY_CLIENT_ID: 'fixture-id',
  TEES4_SHOPIFY_CLIENT_SECRET: 'fixture-secret',
};
const config = shopifyReadConfig(env);
const id = 'gid://shopify/Product/2';
const identity = {
  shop: { id: config.shopId, myshopifyDomain: config.domain },
  currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] },
};
const grant = { access_token: 'fixture-token', expires_in: 86_400 };
const variant = (n: number, sku: string | null = '000710', size = 'M', color = 'White') => ({
  id: `gid://shopify/ProductVariant/${n}`, sku,
  selectedOptions: [{ name: 'Size', value: size }, { name: 'Color', value: color }],
});
const product = (nodes: unknown[], endCursor: string | null = null) => ({
  id, title: 'Fixture Product', handle: 'fixture-product', status: 'ACTIVE', vendor: 'Fixture Vendor',
  publishedAt: '2026-10-05T12:00:00Z',
  options: [{ id: 'fixture-option', name: 'Color', optionValues: [{ name: 'White' }, { name: 'Black' }] }],
  variants: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
});

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'X-Shopify-API-Version': '2026-10', ...headers } });
}

function mocked(responses: (Response | Error)[], waits: number[] = []) {
  const calls: Request[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(new Request(url, init));
    const result = responses.shift();
    assert.ok(result, 'Unexpected Shopify request');
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, client: new ShopifyReadonlyClient(config, fetcher, async delay => { waits.push(delay); }) };
}

test('uses the supported grant and only fixed read queries while retrieving all variant pages', async () => {
  const { calls, client } = mocked([
    response(grant), response({ data: identity }),
    response({ data: { product: product(Array.from({ length: 100 }, (_, n) => variant(n + 1)), 'page-2') } }),
    response({ data: { product: product([variant(101, ''), variant(102, ' 000007 ')]) } }),
  ]);
  const actual = await client.product(id);
  assert.equal(actual.variants.length, 102);
  assert.equal(actual.variants[100]?.sku, '');
  assert.equal(actual.variants[101]?.sku, ' 000007 ');
  assert.equal(actual.publishedAt, '2026-10-05T12:00:00Z');
  assert.deepEqual(actual.options[0]?.values, ['White', 'Black']);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(new URL(call.url).hostname, config.domain);
    assert.equal(call.method, 'POST');
    assert.equal(call.redirect, 'error');
  }
  assert.equal(new URL(calls[0]!.url).pathname, '/admin/oauth/access_token');
  const form = new URLSearchParams(await calls[0]!.text());
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_secret'), 'fixture-secret');
  for (const call of calls.slice(1)) {
    assert.equal(new URL(call.url).pathname, '/admin/api/2026-10/graphql.json');
    assert.equal(call.headers.get('X-Shopify-Access-Token'), 'fixture-token');
    assert.match((await call.clone().json()).query, /^query Tees4Read/);
  }
  assert.deepEqual((await calls[3]!.json()).variables, { id, first: 100, after: 'page-2' });
});

test('fails closed on auth, scope, identity and version failures', async () => {
  for (const [responses, code] of [
    [[response({ error: 'contains secret' }, 401)], 'SHOPIFY_AUTH'],
    [[response(grant), response({ data: identity }, 403)], 'SHOPIFY_PERMISSION'],
    [[response(grant), response({ data: { ...identity, currentAppInstallation: { accessScopes: [] } } })], 'SHOPIFY_PERMISSION'],
    [[response(grant), response({ data: { ...identity, currentAppInstallation: { accessScopes: [
      { handle: 'read_products' }, { handle: 'write_products' },
    ] } } })], 'SHOPIFY_PERMISSION'],
    [[response(grant), response({ data: { ...identity, shop: { ...identity.shop, id: 'gid://shopify/Shop/99' } } })], 'SHOPIFY_SHOP_MISMATCH'],
    [[response(grant), response({ data: identity }, 200, { 'X-Shopify-API-Version': '2026-07' })], 'SHOPIFY_VERSION'],
  ] as const) {
    const { client, calls } = mocked([...responses]);
    await assert.rejects(client.product(id), { code });
    assert.equal(calls.length, responses.length);
  }
  assert.throws(() => shopifyReadConfig({ ...env, TEES4_SHOPIFY_DOMAIN: 'fixture.myshopify.com.evil.test' }), {
    code: 'INVALID_SHOPIFY_CONFIG',
  });
});

test('distinguishes inaccessible products from permission errors and rejects repeated cursors', async () => {
  const auth = () => [response(grant), response({ data: identity })];
  const absent = mocked([...auth(), response({ data: { product: null } })]);
  await assert.rejects(absent.client.product(id), { code: 'SHOPIFY_PRODUCT_NOT_FOUND' });
  const denied = mocked([...auth(), response({ errors: [{ extensions: { code: 'ACCESS_DENIED' } }] })]);
  await assert.rejects(denied.client.product(id), { code: 'SHOPIFY_PERMISSION' });
  const cursor = mocked([...auth(), response({ data: { product: product([], 'again') } }),
    response({ data: { product: product([], 'again') } })]);
  await assert.rejects(cursor.client.product(id), { code: 'SHOPIFY_PAGINATION' });
});

test('honors throttling and retries network interruptions without sending mutations', async () => {
  const waits: number[] = [];
  const { client } = mocked([
    response(grant), response({ data: identity }),
    new Error('Interrupted socket'),
    response({}, 429, { 'Retry-After': '2' }),
    response({ errors: [{ extensions: { code: 'THROTTLED' } }],
      extensions: { cost: { requestedQueryCost: 94, throttleStatus: { currentlyAvailable: 4, restoreRate: 30 } } } }),
    response({ data: { product: product([variant(3)]) } }),
  ], waits);
  assert.equal((await client.product(id)).variants.length, 1);
  assert.deepEqual(waits, [250, 2000, 3000]);
  const longWait = mocked([response(grant), response({ data: identity }), response({}, 429, { 'Retry-After': '90' })], waits);
  await assert.rejects(longWait.client.product(id), { code: 'SHOPIFY_THROTTLED' });
  const offline = mocked(Array.from({ length: 4 }, () => new Error('offline')));
  await assert.rejects(offline.client.verifyShop(), { code: 'SHOPIFY_TRANSIENT' });
});

async function assignment() {
  const bindings = readJson('examples/shopify-readonly-bindings.json', 'bindings') as Record<string, unknown>[];
  const fixture = readJson('examples/sheet-input.json', 'sheet fixture') as { artwork: unknown; rows: unknown };
  const artwork = await readProductionArtwork(fixture.artwork, simulatedSheets(fixture.rows));
  const binding = selectShopifyBinding(bindings, config.shopId, 2);
  return { bindings, binding, artwork, assigned: shopifyAssignment(artwork, binding) };
}

test('matches explicit bindings and rejects ambiguous ownership or mismatched physical assignments', async () => {
  const { bindings, binding, artwork } = await assignment();
  assert.throws(() => selectShopifyBinding([...bindings, { ...bindings[0], sourceRow: 9 }], config.shopId, 2), {
    code: 'AMBIGUOUS_SHOPIFY_BINDING',
  });
  assert.throws(() => selectShopifyBinding(bindings, 'gid://shopify/Shop/19', 2), { code: 'SHOPIFY_BINDING_NOT_FOUND' });
  assert.throws(() => shopifyAssignment(artwork, { ...binding, productSku: '710' }), { code: 'SHOPIFY_BINDING_MISMATCH' });
});

test('reports blank, expected and unexpected SKUs, variant ID drift and size/color changes', async () => {
  const { binding, assigned } = await assignment();
  const { client } = mocked([response(grant), response({ data: identity }),
    response({ data: { product: product([
      variant(3, '', 'XL', 'Red'), variant(3, '000710'),
      variant(5, 'original-final-SKU'), { ...variant(6, ' 000710 '), id: null },
    ]) } }),
  ]);
  const report = compareShopifyProduct(await client.product(id), binding, assigned);
  assert.equal(report.status, 'needs_review');
  assert.deepEqual(report.blankVariantIds, [variant(3).id]);
  assert.deepEqual(report.expectedSkuVariantIds, [variant(3).id]);
  assert.deepEqual(report.unexpectedSkus, [{ variantId: variant(5).id, sku: 'original-final-SKU' }, { variantId: null, sku: ' 000710 ' }]);
  assert.deepEqual(report.missingVariantIds, [variant(4).id]);
  assert.deepEqual(report.duplicateVariantIds, [variant(3).id]);
  assert.deepEqual(report.unboundVariantIds, [variant(5).id]);
  assert.equal(report.variantsWithoutId, 1);
  assert.deepEqual(report.optionMismatches.map(value => value.option), ['size', 'color']);
  assert.deepEqual(report.colorDifferences, { missing: ['Black'], unexpected: ['Red'] });
  assert.deepEqual(report.proposedAssignments, []);
  assert.deepEqual(report.publication, { productStatus: 'ACTIVE', onlineStorePublishedAt: '2026-10-05T12:00:00Z' });
});

test('previews assignments only for verified blank variants and preserves final values', async () => {
  const { binding, assigned } = await assignment();
  const { client } = mocked([response(grant), response({ data: identity }), response({ data: {
    product: product([variant(3, null), variant(4, '000710', 'L', 'Black')]),
  } })]);
  const actual: ProductRead = await client.product(id);
  const preview = compareShopifyProduct(actual, binding, assigned);
  assert.deepEqual(preview.proposedAssignments, [{ variantId: variant(3).id, sku: '000710' }]);
  assert.equal(preview.status, 'sku_assignment_required');
  actual.variants[1]!.sku = 'Hextom-style-value';
  const protectedReport = compareShopifyProduct(actual, binding, assigned);
  assert.equal(protectedReport.product.variants[1]?.sku, 'Hextom-style-value');
  assert.deepEqual(protectedReport.proposedAssignments, []);
});

test('all Shopify CLI paths stay read-only during the protected window', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tees4-shopify-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, 'mock.mjs');
  const database = join(directory, 'should-not-exist.sqlite');
  writeFileSync(preload, `
    Date.now = () => Date.parse('2026-11-24T00:00:00Z');
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      if (url.hostname !== 'fixture.myshopify.com' || init.redirect !== 'error') throw new Error('Unexpected host');
      if (url.pathname === '/admin/oauth/access_token') return Response.json(${JSON.stringify(grant)});
      const payload = JSON.parse(init.body);
      if (url.pathname !== '/admin/api/2026-10/graphql.json' || !/^query Tees4Read/.test(payload.query)) {
        throw new Error('Unexpected Shopify operation');
      }
      const data = payload.query.includes('Tees4ReadIdentity') ? ${JSON.stringify(identity)} :
        { product: ${JSON.stringify(product([variant(3, null), variant(4, '000710', 'L', 'Black')]))} };
      return Response.json({ data }, { headers: { 'X-Shopify-API-Version': '2026-10' } });
    };`);
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--import', preload, 'dist/src/cli.js', ...args,
    ], { encoding: 'utf8', env: { ...process.env, ...env, TEES4_DATABASE: database } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run('shopify-auth').id, config.shopId);
  assert.equal(run('shopify-product', id).id, id);
  assert.equal(run('shopify-variants', id).variants.length, 2);
  const compare = ['examples/shopify-readonly-bindings.json', '2', 'examples/sheet-input.json', '--fixture'];
  assert.equal(run('shopify-compare', ...compare).status, 'sku_assignment_required');
  assert.equal(run('shopify-preview', ...compare).proposedAssignments.length, 1);
  assert.equal(existsSync(database), false);
});
