import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readJson } from '../src/config.js';
import { readProductionArtwork, simulatedSheets } from '../src/sheets.js';
import { discoverAdjustProducts, summarizeAdjustProduct } from '../src/shopify-adjust.js';
import { compareShopifyProduct, selectShopifyBinding, shopifyAssignment } from '../src/shopify-comparison.js';
import { identifyShop, shopifyIdentifyConfig, shopifyReadConfig, ShopifyReadonlyClient } from '../src/shopify-readonly.js';
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
  publishedAt: '2026-10-05T12:00:00Z', tags: [],
  createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-11-24T12:00:00Z',
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
        payload.query.includes('Tees4ReadAdjustCandidates') ?
        { products: { nodes: [], pageInfo: { hasNextPage: false } } } :
        { product: ${JSON.stringify(product([variant(3, null), variant(4, '000710', 'L', 'Black')]))} };
      return Response.json({ data }, { headers: { 'X-Shopify-API-Version': '2026-10' } });
    };`);
  const cli = (shopId: string, ...args: string[]) => spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--import', preload, 'dist/src/cli.js', ...args,
    ], { encoding: 'utf8', env: {
      ...process.env, ...env, TEES4_SHOPIFY_SHOP_ID: shopId, TEES4_DATABASE: database,
    } });
  const run = (...args: string[]) => {
    const result = cli(config.shopId, ...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run('shopify-auth').id, config.shopId);
  assert.equal(run('shopify-product', id).id, id);
  assert.equal(run('shopify-variants', id).variants.length, 2);
  assert.equal(run('shopify-adjust').count, 0);
  assert.equal(run('shopify-adjust', id).hasAdjustTag, false);
  const compare = ['examples/shopify-readonly-bindings.json', '2', 'examples/sheet-input.json', '--fixture'];
  assert.equal(run('shopify-compare', ...compare).status, 'sku_assignment_required');
  assert.equal(run('shopify-preview', ...compare).proposedAssignments.length, 1);
  const bootstrap = cli('', 'shopify-identify');
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.deepEqual(JSON.parse(bootstrap.stdout), {
    id: config.shopId, domain: config.domain, apiVersion: config.version, scopes: ['read_products'],
  });
  assert.doesNotMatch(bootstrap.stdout, /fixture-secret|fixture-token/);
  for (const args of [['shopify-auth'], ['shopify-product', id]]) {
    const strict = cli('', ...args);
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /INVALID_SHOPIFY_ID/);
  }
  assert.equal(existsSync(database), false);
});

test('bootstrap uses only the identity query and fails closed on mismatched domain, GID, scope or version', async () => {
  const { TEES4_SHOPIFY_SHOP_ID: _, ...bootstrapEnv } = env;
  const bootstrap = shopifyIdentifyConfig(bootstrapEnv);
  assert.throws(() => shopifyReadConfig(bootstrapEnv), { code: 'INVALID_SHOPIFY_ID' });
  const authenticate = (identityResponse: Response) => {
    const fetcher: typeof fetch = async (url, init) => {
      const request = new Request(url, init);
      assert.equal(new URL(request.url).hostname, config.domain);
      if (new URL(request.url).pathname === '/admin/oauth/access_token') return response(grant);
      const body = await request.json();
      assert.match(body.query, /^query Tees4ReadIdentity/);
      assert.doesNotMatch(body.query, /product\s*\(/);
      return identityResponse;
    };
    return identifyShop(bootstrap, fetcher);
  };
  assert.deepEqual(await authenticate(response({ data: identity })), {
    id: config.shopId, domain: config.domain, apiVersion: config.version, scopes: ['read_products'],
  });
  await assert.rejects(authenticate(response({ data: { ...identity, shop: {
    ...identity.shop, myshopifyDomain: 'different.myshopify.com',
  } } })), { code: 'SHOPIFY_SHOP_MISMATCH' });
  await assert.rejects(authenticate(response({ data: { ...identity, shop: {
    ...identity.shop, id: 'gid://shopify/Product/1',
  } } })), { code: 'INVALID_SHOPIFY_ID' });
  await assert.rejects(authenticate(response({ data: { ...identity, currentAppInstallation: {
    accessScopes: [{ handle: 'read_products' }, { handle: 'write_products' }],
  } } })), { code: 'SHOPIFY_PERMISSION' });
  await assert.rejects(authenticate(response({ data: identity }, 200, { 'X-Shopify-API-Version': '2026-07' })), {
    code: 'SHOPIFY_VERSION',
  });
});

test('product discovery uses authenticated read-only pages and returns at most five products', async () => {
  const summary = (n: number) => ({ id: `gid://shopify/Product/${n}`, title: `Product ${n}` });
  const page = (nodes: ReturnType<typeof summary>[], cursor: string | null) => response({ data: {
    products: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } },
  } });
  const { client, calls } = mocked([
    response(grant), response({ data: identity }),
    page([summary(1), summary(2)], 'cursor-1'),
    page([summary(3), summary(4), summary(5)], 'cursor-2'),
  ]);
  assert.deepEqual(await client.recentProducts(), [1, 2, 3, 4, 5].map(summary));
  assert.equal(calls.length, 4);
  const [first, second] = await Promise.all(calls.slice(2).map(call => call.json()));
  assert.match(first.query, /^query Tees4ReadProducts/);
  assert.match(first.query, /sortKey: CREATED_AT, reverse: true/);
  assert.deepEqual(first.variables, { first: 5, after: null });
  assert.deepEqual(second.variables, { first: 3, after: 'cursor-1' });

  const repeated = mocked([response(grant), response({ data: identity }), page([], 'same'), page([], 'same')]);
  await assert.rejects(repeated.client.recentProducts(), { code: 'SHOPIFY_PAGINATION' });
  const emptyPages = mocked([response(grant), response({ data: identity }),
    ...Array.from({ length: 5 }, (_, i) => page([], `cursor-${i}`)),
  ]);
  assert.deepEqual(await emptyPages.client.recentProducts(), []);
  assert.equal(emptyPages.calls.length, 7);
  const short = mocked([response(grant), response({ data: identity }), page([summary(1)], null)]);
  assert.deepEqual(await short.client.recentProducts(), [summary(1)]);
  const denied = mocked([response(grant), response({ data: { ...identity, shop: { ...identity.shop, id: 'gid://shopify/Shop/99' } } })]);
  await assert.rejects(denied.client.recentProducts(), { code: 'SHOPIFY_SHOP_MISMATCH' });
  assert.equal(denied.calls.length, 2);
});

test('provenance reads only the requested product and never fetches metafield values', async () => {
  const { client, calls } = mocked([response(grant), response({ data: identity }), response({ data: {
    product: {
      id, tags: ['fixture-tag'], createdAt: '2026-11-24T00:00:00Z',
      metafields: { nodes: [{ namespace: 'custom', key: 'origin', value: 'not part of the report' }],
        pageInfo: { hasNextPage: true } },
    },
  } })]);
  assert.deepEqual(await client.productProvenance(id), {
    id, tags: ['fixture-tag'], createdAt: '2026-11-24T00:00:00Z', moreVisibleMetafields: true,
    visibleMetafields: [{ namespace: 'custom', key: 'origin' }],
  });
  const request = await calls[2]!.json();
  assert.match(request.query, /^query Tees4ReadProvenance/);
  assert.doesNotMatch(request.query, /\bvalue\b|\bmutation\b/);
  assert.deepEqual(request.variables, { id });
});

test('adjust discovery pages by tag filter, confirms exact spelling and rechecks candidates on load', async () => {
  const otherId = 'gid://shopify/Product/3';
  const removedId = 'gid://shopify/Product/4';
  const candidate = (productId: string, tags: string[]) => ({ id: productId, title: 'Fixture', status: 'ACTIVE', tags });
  const page = (nodes: unknown[], cursor: string | null) => response({ data: {
    products: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } },
  } });
  const { client, calls } = mocked([
    response(grant), response({ data: identity }),
    page([candidate(otherId, ['ADJUST']), candidate(id, ['adjust'])], 'page-2'),
    page([candidate(removedId, ['adjust'])], null),
    response({ data: { product: { ...product([variant(3), variant(4, null)], 'variant-page-2'), tags: ['adjust'] } } }),
    response({ data: { product: { ...product([variant(5, 'another-sku'), variant(3, '000710')]), tags: ['adjust'] } } }),
    response({ data: { product: { ...product([variant(6)]), id: removedId, tags: ['Adjust'] } } }),
  ]);
  const discovered = await discoverAdjustProducts(client);
  assert.equal(discovered.count, 1);
  assert.deepEqual(discovered.countsByPattern, { uniform: 0, distinct: 0, blank_or_partial_blank: 0, anomalous: 1 });
  assert.deepEqual(discovered.withoutExactTag.map(row => [row.id, row.tags]), [[otherId, ['ADJUST']], [removedId, ['Adjust']]]);
  assert.deepEqual(discovered.products[0]?.tags, ['adjust']);
  assert.equal(discovered.products[0]?.createdAt, '2026-10-03T12:00:00Z');
  assert.equal(discovered.products[0]?.updatedAt, '2026-11-24T12:00:00Z');
  assert.equal(discovered.products[0]?.options[0]?.name, 'Color');
  assert.equal(discovered.products[0]?.variantCount, 4);
  assert.deepEqual(discovered.products[0]?.sku, {
    pattern: 'anomalous',
    blankSkuCount: 1, whitespaceSkuCount: 0, paddedSkuCount: 0, missingVariantIdCount: 0,
    duplicateVariantIds: [variant(3).id], anomalies: ['duplicate_variant_ids', 'mixed_repeated_skus'],
    values: [{ value: '000710', variantCount: 2 }, { value: 'another-sku', variantCount: 1 }],
  });
  const queries = await Promise.all(calls.slice(2).map(call => call.json()));
  assert.match(queries[0].query, /^query Tees4ReadAdjustCandidates/);
  assert.match(queries[0].query, /query: \$search/);
  assert.deepEqual(queries[0].variables, { first: 100, after: null, search: 'tag:adjust' });
  assert.deepEqual(queries[1].variables, { first: 100, after: 'page-2', search: 'tag:adjust' });
  assert.deepEqual(queries.slice(2).map(query => query.variables.id), [id, id, removedId]);
  assert.ok(queries.every(query => /^query Tees4Read/.test(query.query)));
});

test('adjust discovery refuses an incomplete count when a cursor repeats', async () => {
  const page = () => response({ data: {
    products: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } },
  } });
  const { client } = mocked([response(grant), response({ data: identity }), page(), page()]);
  await assert.rejects(discoverAdjustProducts(client), { code: 'SHOPIFY_PAGINATION' });
});


test('exact lowercase tag audits classify SKU patterns without normalizing strings or claiming completion', async () => {
  const cases = [
    { skus: ['000710', '000710'], pattern: 'uniform', candidate: 'possible_pre_hextom' },
    { skus: ['000710', '000711'], pattern: 'distinct', candidate: 'possible_post_hextom' },
    { skus: ['000710', ' 000710 '], pattern: 'anomalous', candidate: 'undetermined' },
    { skus: [null, '', '000710'], pattern: 'blank_or_partial_blank', candidate: 'undetermined' },
    { skus: [null, ''], pattern: 'blank_or_partial_blank', candidate: 'undetermined' },
    { skus: [' '], pattern: 'anomalous', candidate: 'undetermined' },
    { skus: ['000710', '000710', 'another'], pattern: 'anomalous', candidate: 'undetermined' },
    { skus: [], pattern: 'anomalous', candidate: 'undetermined' },
  ];
  for (const { skus, pattern, candidate } of cases) {
    const { client } = mocked([
      response(grant), response({ data: identity }),
      response({ data: { product: { ...product(skus.map((sku, n) => variant(n + 3, sku))), tags: ['adjust', 'KeepAsIs'] } } }),
    ]);
    const report = summarizeAdjustProduct(await client.product(id));
    assert.equal(report.sku.pattern, pattern);
    assert.equal(report.hextomCandidate, candidate);
    assert.deepEqual(report.tags, ['adjust', 'KeepAsIs']);
    assert.deepEqual(report.sku.values.map(entry => entry.value), [...new Set(skus.filter(sku => sku !== '' && sku !== null))]);
  }
});
