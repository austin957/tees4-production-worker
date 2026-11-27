import assert from 'node:assert/strict';
import test from 'node:test';
import { simulatedAdapters, writeAction } from '../src/adapters.js';
import { readJson, settings } from '../src/config.js';
import { assertExportWindow, assertSkuWindow, protectedUntil } from '../src/production-schedule.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';

const start = Date.parse('2026-07-11T21:20:00Z');
const end = Date.parse('2026-07-12T02:10:00Z');
const minute = 60_000;
const artwork = readJson('examples/artwork.json', 'artwork');
const workflow = readJson('examples/workflow.json', 'workflow');

test('the protected window covers 4:20 PM through 9:09 PM Central in both DST offsets', () => {
  for (const [start, end] of [
    ['2026-01-11T22:20:00Z', '2026-01-12T03:10:00Z'], // CST
    ['2026-07-11T21:20:00Z', '2026-07-12T02:10:00Z'], // CDT
    ['2026-03-07T22:20:00Z', '2026-03-08T03:10:00Z'], // before spring transition
    ['2026-03-08T21:20:00Z', '2026-03-09T02:10:00Z'], // after spring transition
    ['2026-10-31T21:20:00Z', '2026-11-01T02:10:00Z'], // before fall transition
    ['2026-11-01T22:20:00Z', '2026-11-02T03:10:00Z'], // after fall transition
  ] as const) {
    const from = Date.parse(start);
    const until = Date.parse(end);
    assert.equal(protectedUntil(from - minute), undefined); // 4:19 PM
    assert.doesNotThrow(() => assertSkuWindow(from - 1));
    for (const now of [from, until - minute, until - 1]) { // 4:20 PM, 9:09 PM
      assert.equal(protectedUntil(now), until);
      assert.throws(() => assertSkuWindow(now), { code: 'HEXTOM_WINDOW', retryAt: until });
      assert.throws(() => assertExportWindow(now, 1), { code: 'MOCKUPIFY_WINDOW', retryAt: until });
    }
    assert.equal(protectedUntil(until), undefined); // 9:10 PM
    assert.doesNotThrow(() => assertSkuWindow(until));
    assert.doesNotThrow(() => assertExportWindow(until, 1));
  }
});

test('new exports need a configured margin and must finish strictly before the next cutoff', () => {
  assert.equal(settings({}).exportMarginMinutes, undefined);
  assert.equal(settings({ TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES: '2' }).exportMarginMinutes, 2);
  for (const value of ['', '-1', '0', '1.5', 'five']) {
    assert.throws(() => settings({ TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES: value }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => assertExportWindow(start - minute, undefined), { code: 'EXPORT_MARGIN_REQUIRED' });
  assert.throws(() => assertExportWindow(start - minute, 1), { code: 'EXPORT_SAFETY_MARGIN', retryAt: end });
  assert.doesNotThrow(() => assertExportWindow(start - minute - 1, 1));

  // The next afternoon is 18h10m away across spring forward and 20h10m across fall back.
  assert.throws(() => assertExportWindow(Date.parse('2026-03-08T03:10:00Z'), 18 * 60 + 10), {
    code: 'EXPORT_SAFETY_MARGIN', retryAt: Date.parse('2026-03-09T02:10:00Z'),
  });
  assert.doesNotThrow(() => assertExportWindow(Date.parse('2026-11-01T02:10:00Z'), 20 * 60 + 9));
});

test('a simulated Mockupify export checks the clock after adapter work and resumes at 9:10 PM', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = start - 2 * minute;
  const adapters = simulatedAdapters(store);
  const generate = adapters.mockupify.generate;
  adapters.mockupify.generate = async (request, beforeExport) => {
    if (now < start) now = start;
    return generate(request, beforeExport);
  };
  const worker = new Worker(store, adapters, undefined, () => now, undefined, 1);
  const { job } = worker.submit(artwork, workflow, 'simulate');
  await worker.runAvailable();
  const deferred = store.get(job.id);
  assert.equal(deferred.status, 'retry_wait');
  assert.equal(deferred.availableAt, end);
  assert.equal(deferred.history.at(-1)?.code, 'MOCKUPIFY_WINDOW');
  assert.equal(deferred.failures, 0);
  assert.equal(deferred.results.length, 4);
  assert.deepEqual(store.effectCounts(), {});

  const dry = worker.submit(artwork, workflow).job;
  await worker.runAvailable();
  assert.equal(store.get(dry.id).status, 'awaiting_approval');
  assert.equal(store.get(dry.id).results[4]?.outcome, 'planned');
  assert.deepEqual(store.effectCounts(), {});

  now = end - minute;
  assert.equal((await worker.runAvailable()).processed, 0);
  now = end;
  await worker.runAvailable();
  const resumed = store.get(job.id);
  assert.equal(resumed.status, 'awaiting_approval');
  assert.deepEqual(resumed.results.slice(0, 4), deferred.results);
  assert.equal(store.effectCounts()['mockupify.generate'], 1);
});

test('pending exports wait for configuration while an existing export receipt remains reusable', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = start - 3 * minute;
  const adapters = simulatedAdapters(store);
  const worker = new Worker(store, adapters, undefined, () => now);
  const { job } = worker.submit(artwork, workflow, 'simulate');
  await worker.runAvailable();
  const deferred = store.get(job.id);
  assert.equal(deferred.history.at(-1)?.code, 'EXPORT_MARGIN_REQUIRED');
  assert.equal(deferred.failures, 0);
  assert.deepEqual(store.effectCounts(), {});

  now = deferred.availableAt;
  // Claim and record the effect without a checkpoint to model an interrupted process.
  const claim = store.claim(now);
  assert.ok(claim);
  assert.equal(claim.job.workflow.stages[claim.job.nextStage]?.id, 'generate-mockup');
  assert.ok('sku' in claim.job.artwork);
  await writeAction(adapters, 'mockupify.generate', claim.job.artwork, () => assertExportWindow(now, 1));
  now = start;
  await worker.runAvailable();
  const reused = store.get(job.id);
  assert.equal(reused.results[4]?.outcome, 'reused');
  assert.equal(store.effectCounts()['mockupify.generate'], 1);
});
