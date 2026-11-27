import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { FakeMockupify, prepare } from './mockupify-writer-fixture.js';

function paths(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tees4 durability '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'worker.sqlite') };
}

function runWorker(path: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    fileURLToPath(new URL('../src/cli.js', import.meta.url)), ...args],
  { env: { SystemRoot: process.env.SystemRoot, TEES4_DATABASE: path }, encoding: 'utf8', timeout: 30_000 });
}

test('durability evidence is backed by distinct SQLite files, reopens, and leaves the live journal untouched', async t => {
  const { directory, path } = paths(t);
  let firstBackup: string;
  let firstBytes: Buffer;
  {
    using opened = new DisposableStack();
    const store = opened.adopt(new Store(path), value => value.close());
    const api = new FakeMockupify();
    const id = await prepare(store, api);
    await api.writer(store).dispatch(id, 'create_batch', api.approve(store, id, 'create_batch'));
    const prior = store.inspectMockupifyJournal(id);
    const first = await store.verifyMockupifyDurability(directory);
    firstBackup = first.backupPath;
    firstBytes = readFileSync(firstBackup);
    using backup = new DatabaseSync(firstBackup, { readOnly: true });
    using recovery = new DatabaseSync(first.recoveryPath, { readOnly: true });
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM mockupify_writer_journal').get()?.n, 1);
    assert.equal(backup.prepare('SELECT correlation_id FROM mockupify_writer_events').get()?.correlation_id, id);
    const probeId = recovery.prepare('SELECT correlation_id FROM mockupify_writer_journal').get()?.correlation_id;
    assert.match(String(probeId), /^[a-f0-9-]{36}$/);
    assert.notEqual(probeId, id);
    assert.equal(recovery.prepare('SELECT correlation_id FROM mockupify_writer_events').get()?.correlation_id, probeId);
    assert.throws(() => store.getMockupifyJournal(String(probeId)), { code: 'MOCKUPIFY_JOURNAL_NOT_FOUND' });
    assert.deepEqual(store.inspectMockupifyJournal(id), prior);
    assert.equal(store.hasVerifiedMockupifyDurability(), true);
  }

  const reopened = runWorker(path, 'mockupify-durability-status');
  assert.ifError(reopened.error);
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(JSON.parse(reopened.stdout).admitted, true);

  const second = runWorker(path, 'mockupify-durability-verify', directory);
  assert.ifError(second.error);
  assert.equal(second.status, 0, second.stderr);
  const secondStatus = JSON.parse(second.stdout);
  assert.equal(secondStatus.admitted, true);
  assert.notEqual(secondStatus.backupPath, firstBackup);
  assert.deepEqual(readFileSync(firstBackup), firstBytes);
});

test('forged flags, modified receipt timestamps and stale or future evidence all fail closed', async t => {
  const { directory, path } = paths(t);
  using opened = new DisposableStack();
  const store = opened.adopt(new Store(path), value => value.close());
  writeFileSync(path + '.durability.json', JSON.stringify({ admitted: true, verifiedAt: Date.now() }));
  assert.equal(store.hasVerifiedMockupifyDurability(), false);
  const verified = await store.verifyMockupifyDurability(directory);
  {
    const time = t.mock.method(Date, 'now', () => verified.expiresAt);
    assert.match(blockedReason(store), /expired/);
    time.mock.mockImplementation(() => verified.startedAt - 1);
    assert.match(blockedReason(store), /future/);
    time.mock.restore();
  }

  using db = new DatabaseSync(path);
  db.prepare('UPDATE mockupify_durability SET started_at = ?').run(verified.startedAt - 1);
  assert.match(blockedReason(store), /does not contain this database verification attempt/);
});

test('damaged or missing artifacts and a failed re-verification revoke admission', async t => {
  const { directory, path } = paths(t);
  using opened = new DisposableStack();
  const store = opened.adopt(new Store(path), value => value.close());
  const verified = await store.verifyMockupifyDurability(directory);
  writeFileSync(verified.backupPath, 'corrupted SQLite backup');
  assert.match(blockedReason(store), /artifact has changed/);

  const second = await store.verifyMockupifyDurability(directory);
  rmSync(second.recoveryPath);
  assert.match(blockedReason(store), /could not be read/);

  await store.verifyMockupifyDurability(directory);
  await assert.rejects(store.verifyMockupifyDurability(join(directory, 'missing')), { code: 'MOCKUPIFY_DURABILITY_VERIFICATION' });
  assert.match(blockedReason(store), /No matching completed verification/);
});

test('schema changes and database replacement block previously admitted storage', async t => {
  const { directory, path } = paths(t);
  let backupPath: string;
  {
    using opened = new DisposableStack();
    const store = opened.adopt(new Store(path), value => value.close());
    await store.verifyMockupifyDurability(directory);
    using db = new DatabaseSync(path);
    db.exec('DROP INDEX mockupify_writer_event_history');
    assert.match(blockedReason(store), /schema is unsupported/);
    db.exec('CREATE INDEX mockupify_writer_event_history ON mockupify_writer_events(correlation_id, sequence)');
    assert.match(blockedReason(store), /No matching completed verification/);
    backupPath = (await store.verifyMockupifyDurability(directory)).backupPath;
  }

  // An in-place restore can preserve file identity, but it has only the incomplete verification receipt.
  copyFileSync(backupPath, path);
  using reopened = new DisposableStack();
  const store = reopened.adopt(new Store(path), value => value.close());
  assert.equal(store.hasVerifiedMockupifyDurability(), false);
  await store.verifyMockupifyDurability(directory);
  await store.backupTo(join(directory, 'copy.sqlite'));
  const copied = reopened.adopt(new Store(join(directory, 'copy.sqlite')), value => value.close());
  assert.equal(copied.hasVerifiedMockupifyDurability(), false);
});

test('status and verification do not create a missing production database', t => {
  const { directory, path } = paths(t);
  for (const args of [['mockupify-durability-status'], ['mockupify-durability-verify', directory]]) {
    const run = runWorker(path, ...args);
    assert.ifError(run.error);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /DATABASE_OPEN/);
    assert.equal(existsSync(path), false);
  }
});

function blockedReason(store: Store): string {
  const status = store.mockupifyDurabilityStatus();
  assert.equal(status.admitted, false);
  return status.reason;
}
