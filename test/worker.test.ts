import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { simulatedAdapters, writeAction } from '../src/adapters.js';
import { parseArtwork, parseWorkflow } from '../src/config.js';
import { isProduction, WorkerError } from '../src/model.js';
import { Store } from '../src/store.js';
import { report, Worker } from '../src/worker.js';

const artwork = parseArtwork(JSON.parse(readFileSync('examples/artwork.json', 'utf8')));
const workflow = {
  ...parseWorkflow(JSON.parse(readFileSync('examples/workflow.json', 'utf8'))),
  retryDelayMs: 50,
};
const gate = 'approve-publication';
const morning = Date.parse('2026-07-11T15:00:00Z');

function fixture(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'tees4-test-'));
  const database = join(path, 'jobs.sqlite');
  const cleanup = new DisposableStack();
  t.after(() => cleanup.dispose());
  cleanup.defer(() => rmSync(path, { recursive: true, force: true }));
  const openStore = () => cleanup.adopt(new Store(database), store => store.close());
  return { path, database, store: openStore(), openStore };
}

test('dry-run skips all write methods and still requires a gate', async t => {
  const { store } = fixture(t);
  const adapters = simulatedAdapters(store);
  const neverWrite = async () => { assert.fail('dry-run called a write method'); };
  adapters.mockupify.generate = neverWrite;
  adapters.shopify.create = neverWrite;
  adapters.shopify.publish = neverWrite;
  const worker = new Worker(store, adapters);
  const { job } = worker.submit(artwork, workflow);
  assert.equal(job.mode, 'dry-run');
  assert.equal(job.status, 'queued');
  await worker.runAvailable();
  const waiting = store.get(job.id);
  assert.equal(waiting.status, 'awaiting_approval');
  assert.equal(waiting.results[0]?.outcome, 'validated');
  assert.throws(() => worker.approve(job.id, 'different-gate', 'operator'), { code: 'APPROVAL_MISMATCH' });
  worker.approve(job.id, gate, 'operator');
  await worker.runAvailable();
  const done = store.get(job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.results.filter(stage => stage.outcome === 'planned').length, 3);
  assert.deepEqual(store.effectCounts(), {});
  assert.equal(report(done).artwork.designerId, artwork.designerId);
});

test('CLI recovers a timeout after creating a product across separate invocations', t => {
  const { path, database } = fixture(t);
  const config = join(path, 'workflow.json');
  writeFileSync(config, JSON.stringify({ ...workflow, retryDelayMs: 0 }));
  const exec = (...args: string[]) => {
    const result = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--import', `data:text/javascript,Date.now=()=>${morning}`, 'dist/src/cli.js', ...args,
    ], {
      encoding: 'utf8',
      env: { ...process.env, TEES4_CONFIG: config, TEES4_DATABASE: database, TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const job = exec('submit', 'examples/artwork.json', '--mode', 'simulate');
  assert.equal(job.status, 'queued');
  const duplicate = exec('submit', 'examples/artwork.json', '--mode', 'simulate');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.jobId, job.jobId);
  exec('run', '--limit', '6', '--fail-after-create');
  const retry = exec('inspect', job.jobId);
  assert.equal(retry.status, 'retry_wait');
  assert.ok(retry.history.some((entry: { code?: string }) => entry.code === 'SIMULATED_TIMEOUT'));
  assert.deepEqual(exec('effects'), { 'mockupify.generate': 1, 'shopify.create': 1 });
  exec('run');
  const waiting = exec('inspect', job.jobId);
  assert.equal(waiting.awaitingApproval, gate);
  assert.equal(waiting.stages.find((stage: { stageId: string }) => stage.stageId === 'create-product-draft').outcome, 'reused');
  assert.deepEqual(exec('effects'), { 'mockupify.generate': 1, 'shopify.create': 1 });
  exec('approve', job.jobId, gate, '--by', 'test-operator');
  exec('approve', job.jobId, gate, '--by', 'second-operator');
  exec('run');
  const done = exec('list')[0];
  assert.equal(done.status, 'completed');
  assert.equal(done.artwork.designerId, artwork.designerId);
  assert.deepEqual(done.stages.find((stage: { stageId: string }) => stage.stageId === gate).details, { approver: 'test-operator' });
  assert.deepEqual(exec('effects'), { 'mockupify.generate': 1, 'shopify.create': 1, 'shopify.publish': 1 });
});

test('expired stage leases are recovered and stale checkpoints are fenced', async t => {
  const { store, openStore } = fixture(t);
  const second = openStore();
  let now = morning;
  const adapters = simulatedAdapters(store);
  const worker = new Worker(store, adapters, undefined, () => now, undefined, 1);
  const { job } = worker.submit(artwork, workflow, 'simulate');
  await worker.runAvailable(5);
  const claim = store.claim(now);
  assert.ok(claim);
  assert.equal(claim.job.workflow.stages[claim.job.nextStage]?.id, 'create-product-draft');
  assert.ok(!isProduction(claim.job.artwork));
  await writeAction(adapters, 'shopify.create', claim.job.artwork, () => assert.fail('Draft creation called the export guard'));
  assert.equal(second.claim(now), undefined);

  now += workflow.leaseMs;
  const resumed = new Worker(second, simulatedAdapters(second), undefined, () => now);
  await resumed.runAvailable();
  assert.equal(store.finish(claim, { stageId: 'create-product-draft', outcome: 'applied' }, now), undefined);
  const recovered = second.get(job.id);
  assert.equal(recovered.status, 'awaiting_approval');
  assert.ok(recovered.history.some(entry => entry.event === 'lease_recovered'));
  assert.equal(recovered.results.find(stage => stage.stageId === 'create-product-draft')?.outcome, 'reused');
  assert.deepEqual(second.effectCounts(), { 'mockupify.generate': 1, 'shopify.create': 1 });
});

test('retry delays and attempt limits persist without rerunning completed stages', async t => {
  const { store } = fixture(t);
  let now = morning;
  const adapters = simulatedAdapters(store);
  adapters.mockupify.generate = async () => { throw new WorkerError('TEMPORARY', 'Simulated service unavailable.', true); };
  const worker = new Worker(store, adapters, undefined, () => now, undefined, 1);
  const { job } = worker.submit(artwork, { ...workflow, maxAttempts: 2 }, 'simulate');
  await worker.runAvailable();
  const waiting = store.get(job.id);
  assert.equal(waiting.status, 'retry_wait');
  assert.equal(waiting.availableAt, now + 50);
  assert.equal((await worker.runAvailable()).processed, 0);
  now += 50;
  assert.deepEqual(await worker.runAvailable(), { processed: 1, failed: [job.id] });
  const failed = store.get(job.id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.results, waiting.results);
  assert.deepEqual(store.effectCounts(), {});
});

test('missing information, source mismatches and conflicting products stop processing', async t => {
  const { store } = fixture(t);
  const adapters = simulatedAdapters(store);
  const worker = new Worker(store, adapters, undefined, () => morning, undefined, 1);
  assert.throws(() => worker.submit({ ...artwork, designerId: '' }, workflow), { code: 'INVALID_INPUT' });
  assert.equal(store.list().length, 0);
  const { job } = worker.submit(artwork, workflow, 'simulate');
  assert.throws(() => worker.submit({ ...artwork, productTitle: 'Changed' }, workflow, 'simulate'), { code: 'JOB_CONFLICT' });
  await worker.runAvailable();
  assert.equal(store.get(job.id).status, 'awaiting_approval');
  const conflict = worker.submit({ ...artwork, artworkId: 'another-artwork' }, workflow, 'simulate').job;
  await worker.runAvailable();
  assert.equal(store.get(conflict.id).history.at(-1)?.code, 'EFFECT_CONFLICT');
  assert.equal(store.effectCounts()['shopify.create'], 1);
  adapters.sheets.readAssignment = async () => ({});
  const mismatch = worker.submit({ ...artwork, sku: 'fixture-mismatch' }, workflow, 'simulate').job;
  await worker.runAvailable();
  assert.equal(store.get(mismatch.id).history.at(-1)?.code, 'SOURCE_MISMATCH');
  assert.equal(store.effectCounts()['shopify.publish'], undefined);
});
