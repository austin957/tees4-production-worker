import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockupifyReadOnly } from '../src/mockupify-readonly.js';

const env = { TEES4_MOCKUPIFY_API_KEY: 'fixture-key' };
const created = '2026-01-01T00:00:00Z';
const batch = { id: 1, name: 'Fixture batch', designs_count: 0 };
const summary = { id: 1, batch: null, status: 'finished', created, images: { total: 2, done: 2 } };
const design = { id: 2, title: 'Fixture design', batch: 1, batch_name: batch.name, design_id: 'fixture', created };
const product = { id: 3, title: 'Fixture tee', type: 'Shirt', library: false, colors: [{ id: 4, name: 'Blue', price: '5.00', sizes: ['M'] }] };
const exportProduct = {
  design: { id: 2, title: 'Fixture design', design_id: null },
  product: { id: 3, title: 'Fixture tee' }, colors: [4], status: 'created',
};
const detail = { ...summary, products: [exportProduct], errors: [] };

function page(results: unknown[], next: string | null = null, count = results.length) {
  return Response.json({ results, next, count });
}

test('Mockupify requires a credential and handles 401 and 403 without leaking response bodies', async () => {
  assert.throws(() => mockupifyReadOnly({}), { code: 'MOCKUPIFY_MISSING_CREDENTIAL' });
  for (const status of [401, 403]) {
    let requests = 0;
    const client = mockupifyReadOnly(env, async () => {
      requests++;
      return new Response('fixture-key must stay private', { status });
    });
    await assert.rejects(client.listBatches(), {
      code: 'MOCKUPIFY_AUTH_FAILED',
      message: `Mockupify rejected authentication or access (HTTP ${status}).`,
    });
    assert.equal(requests, 1);
  }
});

test('Mockupify paginates over HTTPS and preserves a design batch filter', async () => {
  const urls: string[] = [];
  const client = mockupifyReadOnly(env, async (input, options) => {
    urls.push(String(input));
    assert.equal(options?.method, 'GET');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-key');
    if (urls.length === 1) {
      return page([design], 'http://mockupify.io/api/designs/?page=2&page_size=500&batch=1', 2);
    }
    return page([{ ...design, id: 5 }], null, 2);
  });
  assert.deepEqual((await client.listDesigns(1)).map(row => row.id), [2, 5]);
  assert.deepEqual(urls, [
    'https://mockupify.io/api/designs/?page_size=500&batch=1',
    'https://mockupify.io/api/designs/?page_size=500&batch=1&page=2',
  ]);
});

test('Mockupify rejects unsafe, cyclic or altered pagination links before a second request', async () => {
  for (const next of [
    'https://foreign.example/api/designs/?page=2&page_size=500&batch=1',
    'https://user:pass@mockupify.io/api/designs/?page=2&page_size=500&batch=1',
    'https://mockupify.io:8080/api/designs/?page=2&page_size=500&batch=1',
    '/api/products/?page=2&page_size=500&batch=1',
    '?page=1&page_size=500&batch=1',
    '?page=2&page_size=500&batch=2',
  ]) {
    let requests = 0;
    const client = mockupifyReadOnly(env, async () => {
      requests++;
      return page([design], next, 2);
    });
    await assert.rejects(client.listDesigns(1), { code: 'MOCKUPIFY_INVALID_RESPONSE' });
    assert.equal(requests, 1);
  }
});

test('Mockupify retries rate-limited reads with Retry-After seconds, dates and fallback backoff', async () => {
  const responses = [
    new Response('', { status: 429, headers: { 'Retry-After': '2' } }),
    new Response('', { status: 429, headers: { 'Retry-After': 'Thu, 01 Jan 1970 00:00:01 GMT' } }),
    new Response('', { status: 429 }),
    page([batch]),
  ];
  const delays: number[] = [];
  const urls: string[] = [];
  const client = mockupifyReadOnly(env, async input => {
    urls.push(String(input));
    return responses.shift()!;
  }, async delay => { delays.push(delay); });
  assert.deepEqual(await client.listBatches(), [{ id: 1, name: batch.name, designsCount: 0 }]);
  assert.deepEqual(delays, [2000, 0, 4000]);
  assert.equal(urls.length, 4);
  assert.equal(new Set(urls).size, 1);
});

test('Mockupify surfaces rate limits after bounded retries or a long Retry-After', async () => {
  for (const [header, expectedAttempts] of [['1', 4], ['120', 1]] as const) {
    let attempts = 0;
    const client = mockupifyReadOnly(env, async () => {
      attempts++;
      return new Response(null, { status: 429, headers: { 'Retry-After': header } });
    }, async () => {});
    await assert.rejects(client.listExports(), { code: 'MOCKUPIFY_RATE_LIMITED', retryable: true });
    assert.equal(attempts, expectedAttempts);
  }
});

test('Mockupify rejects malformed JSON, incomplete pages and missing template IDs', async () => {
  const responses = [
    new Response('<html>fixture</html>'),
    Response.json({ count: 1, results: [{ ...product, id: undefined }] }),
    Response.json({ count: 1, results: [] }),
    Response.json({ count: 0, results: {} }),
  ];
  const client = mockupifyReadOnly(env, async () => responses.shift()!);
  for (let index = 0; index < 4; index++) {
    await assert.rejects(client.listProducts(), { code: 'MOCKUPIFY_INVALID_RESPONSE' });
  }
});

test('Mockupify returns the template and color IDs from the product catalog', async () => {
  const client = mockupifyReadOnly(env, async () => page([product]));
  assert.deepEqual(await client.listProducts(), [product]);
});

test('Mockupify accepts historical null batches and empty product lists', async () => {
  const client = mockupifyReadOnly(env, async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/exports/') return page([summary]);
    assert.equal(path, '/api/exports/1/');
    return Response.json({ ...detail, products: [] });
  });
  assert.deepEqual(await client.listExports(), [summary]);
  assert.deepEqual(await client.getExport(1), { ...summary, products: [], errors: [] });
});

test('Mockupify preserves returned Shopify IDs and represents missing IDs without inventing a GID', async () => {
  const client = mockupifyReadOnly(env, async () => Response.json({
    ...detail,
    products: [
      exportProduct,
      { ...exportProduct, shopify_product_id: '123', shopify_product_gid: null },
      { ...exportProduct, shopify_product_id: '456', shopify_product_gid: 'gid://shopify/Product/456' },
    ],
  }));
  assert.deepEqual((await client.getExport(1)).products.map(row => [row.shopifyProductId, row.shopifyProductGid]), [
    [null, null], ['123', null], ['456', 'gid://shopify/Product/456'],
  ]);
});

test('Mockupify rejects malformed or inconsistent export IDs and never sends an invalid detail request', async () => {
  const responses = [
    Response.json({ ...detail, id: 2 }),
    Response.json({ ...detail, products: [{ ...exportProduct, product: { title: 'Missing ID' } }] }),
    Response.json({ ...detail, products: [{ ...exportProduct, shopify_product_gid: 'gid://shopify/ProductVariant/123' }] }),
    Response.json({ ...detail, products: [{ ...exportProduct, shopify_product_id: '123', shopify_product_gid: 'gid://shopify/Product/456' }] }),
  ];
  const client = mockupifyReadOnly(env, async () => responses.shift()!);
  await assert.rejects(client.getExport(0), { code: 'MOCKUPIFY_INVALID_ID' });
  assert.equal(responses.length, 4);
  for (let index = 0; index < 4; index++) {
    await assert.rejects(client.getExport(1), { code: 'MOCKUPIFY_INVALID_RESPONSE' });
  }
});
