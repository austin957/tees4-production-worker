import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, fsyncSync, mkdtempSync, openSync, readSync, realpathSync,
  rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { WorkerError } from './model.js';
import { mockupifyDigest } from './mockupify-writer-model.js';
import type { MockupifyClaim } from './mockupify-writer-model.js';
import { shopifySkuSchema, workerSchema } from './store-schema.js';

const evidenceLifetime = 24 * 60 * 60 * 1000;
const evidenceVersion = 1;
const evidenceSchema = `
  CREATE TABLE IF NOT EXISTS mockupify_durability (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    database_identity TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    artifact_dir TEXT,
    backup_sha256 TEXT,
    recovery_sha256 TEXT
  );
`;

export function databaseIdentity(path: string): string | null {
  if (path === ':memory:') return null;
  try {
    const canonical = realpathSync.native(path);
    const info = statSync(canonical, { bigint: true });
    if (!info.isFile() || info.ino === 0n || info.birthtimeNs <= 0n) return null;
    return JSON.stringify([canonical, String(info.dev), String(info.ino), String(info.birthtimeNs)]);
  } catch {
    return null;
  }
}

export async function sqliteBackupTo(db: DatabaseSync, path: string): Promise<void> {
  const file = openSync(path, 'wx', 0o600);
  try {
    try {
      await backup(db, path);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
  } catch (error) {
    unlinkSync(path);
    throw error;
  }
}

function fileDigest(path: string): string {
  const file = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(64 * 1024);
    let size: number;
    while ((size = readSync(file, bytes, 0, bytes.length, null)) > 0) hash.update(bytes.subarray(0, size));
    return hash.digest('hex');
  } finally {
    closeSync(file);
  }
}

function schema(db: DatabaseSync) {
  return db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name
  `).all().map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name,
    sql: (sql as string).replace(/\s+/g, ' ').trim() }));
}

function checkSchema(db: DatabaseSync, evidence?: boolean) {
  using reference = new DatabaseSync(':memory:');
  const actual = schema(db);
  const skuSchema = actual.some(row => String(row.name).startsWith('shopify_sku_')) ? shopifySkuSchema : '';
  reference.exec(workerSchema + skuSchema + (evidence === false ? '' : evidenceSchema));
  const expected = schema(reference);
  const comparable = actual.some(row => row.name === 'mockupify_durability') || evidence !== undefined
    ? expected : expected.filter(row => row.name !== 'mockupify_durability');
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 0 ||
    db.prepare('PRAGMA application_id').get()?.application_id !== 0 ||
    mockupifyDigest(actual) !== mockupifyDigest(comparable)) {
    fail('The database schema is unsupported for durability admission.');
  }
}

function checkIntegrity(db: DatabaseSync) {
  const checks = db.prepare('PRAGMA integrity_check').all();
  if (checks.length !== 1 || checks[0]?.integrity_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').get()) {
    fail('The SQLite integrity or foreign key check failed.');
  }
}

function checkIdentity(path: string, identity: string | null) {
  if (!identity || databaseIdentity(path) !== identity) fail('The database file identity changed or is unavailable.');
}

function checkDatabase(db: DatabaseSync, path: string, identity: string | null) {
  checkIdentity(path, identity);
  if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' ||
    db.prepare('PRAGMA synchronous').get()?.synchronous !== 2) {
    fail('Durability admission requires SQLite WAL with FULL synchronization.');
  }
}

function evidenceRow(db: DatabaseSync) {
  return db.prepare('SELECT * FROM mockupify_durability WHERE id = 1').get();
}

function fail(message: string): never {
  throw new WorkerError('MOCKUPIFY_DURABILITY_VERIFICATION', message);
}

function artifact(path: string) {
  // SQLite backups are self-contained. Read the exact hashed file without opening sidecars.
  return new DatabaseSync(pathToFileURL(path).href + '?mode=ro&immutable=1', { readOnly: true });
}

function checkSnapshot(db: DatabaseSync, evidence: Record<string, SQLOutputValue>) {
  checkSchema(db, true);
  checkIntegrity(db);
  const saved = evidenceRow(db);
  if (!saved || saved.version !== evidence.version || saved.nonce !== evidence.nonce ||
    saved.started_at !== evidence.started_at || saved.database_identity !== evidence.database_identity ||
    saved.schema_version !== evidence.schema_version || saved.artifact_dir !== null ||
    saved.backup_sha256 !== null || saved.recovery_sha256 !== null) {
    fail('The backup does not contain this database verification attempt.');
  }
}

function probeClaim(nonce: string, startedAt: number): MockupifyClaim {
  const request = { operation: 'create_batch', path: '/api/batches/', json: { name: nonce } } as const;
  return {
    request, requestDigest: mockupifyDigest(request), claimedAt: startedAt, designId: null,
    approval: { operation: 'create_batch', digest: mockupifyDigest([nonce, request]),
      by: 'SQLite durability probe', evidence: nonce, expiresAt: startedAt + evidenceLifetime },
    state: 'dispatching',
  };
}

function checkProbe(db: DatabaseSync, nonce: string, startedAt: number) {
  checkSchema(db, false);
  checkIntegrity(db);
  const journal = db.prepare('SELECT * FROM mockupify_writer_journal').all();
  const events = db.prepare('SELECT * FROM mockupify_writer_events').all();
  const claim = { ...probeClaim(nonce, startedAt), budgetSequence: 1 };
  const expected = { plan: { correlation: { correlationId: nonce, productSku: nonce, spreadsheetId: nonce, sourceRow: 2 },
    review: { exclusiveBatchControlEvidence: nonce } },
    revision: 1, batchId: null, designId: null, exportId: null, claims: { create_batch: claim } };
  if (journal.length !== 1 || journal[0]?.correlation_id !== nonce || journal[0]?.product_sku !== nonce ||
    journal[0]?.body !== JSON.stringify(expected) || events.length !== 1 || events[0]?.correlation_id !== nonce ||
    events[0]?.body !== JSON.stringify({ event: 'claim', ...claim })) {
    fail('The isolated journal claim and its event did not recover after process exit.');
  }
}

function recoverProbe(path: string, nonce: string, startedAt: number) {
  const storeModule = new URL('./store.js', import.meta.url).href;
  // Seed only the persistence fields needed by Store.claimMockupifyOperation. This process has no provider client.
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { Store } from ${JSON.stringify(storeModule)};
    const [path, nonce] = process.argv.slice(1);
    const claim = JSON.parse(readFileSync(0, 'utf8'));
    const store = new Store(path);
    const seed = new DatabaseSync(path);
    seed.prepare('INSERT INTO mockupify_writer_journal (correlation_id, product_sku, body) VALUES (?, ?, ?)')
      .run(nonce, nonce, JSON.stringify({
        plan: { correlation: { correlationId: nonce, productSku: nonce, spreadsheetId: nonce, sourceRow: 2 },
          review: { exclusiveBatchControlEvidence: nonce } },
        revision: 0, batchId: null, designId: null, exportId: null, claims: {},
      }));
    seed.close();
    store.claimMockupifyOperation(store.getMockupifyJournal(nonce), claim, [], () => {});
    process.exit(23);
  `, path, nonce], { input: JSON.stringify(probeClaim(nonce, startedAt)), timeout: 30_000, killSignal: 'SIGKILL',
    env: { SystemRoot: process.env.SystemRoot } });
  if (child.error || child.status !== 23 || statSync(path + '-wal').size <= 32) {
    fail('Could not commit the isolated journal and event to WAL before process exit.');
  }
}

export function durabilityStatus(db: DatabaseSync, path: string, identity: string | null) {
  try {
    checkDatabase(db, path, identity);
    checkSchema(db);
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'mockupify_durability'").get()) {
      fail('No successful verification is recorded for this database.');
    }
    const evidence = evidenceRow(db);
    if (!evidence || evidence.version !== evidenceVersion || evidence.database_identity !== identity ||
      typeof evidence.nonce !== 'string' || typeof evidence.started_at !== 'number' ||
      evidence.schema_version !== db.prepare('PRAGMA schema_version').get()?.schema_version ||
      typeof evidence.artifact_dir !== 'string' || typeof evidence.backup_sha256 !== 'string' ||
      typeof evidence.recovery_sha256 !== 'string') {
      fail('No matching completed verification is recorded for this database and schema.');
    }
    const expiresAt = evidence.started_at + evidenceLifetime;
    const now = Date.now();
    if (now < evidence.started_at || now >= expiresAt) fail('The durability verification is expired or dated in the future.');
    const backupPath = join(evidence.artifact_dir, 'backup.sqlite');
    const recoveryPath = join(evidence.artifact_dir, 'recovery.sqlite');
    if (fileDigest(backupPath) !== evidence.backup_sha256 || fileDigest(recoveryPath) !== evidence.recovery_sha256) {
      fail('A verification backup or recovery artifact has changed.');
    }
    using snapshot = artifact(backupPath);
    using recovery = artifact(recoveryPath);
    checkSnapshot(snapshot, evidence);
    checkProbe(recovery, evidence.nonce, evidence.started_at);
    checkIntegrity(db);
    checkDatabase(db, path, identity);
    const checkedAt = Date.now();
    if (checkedAt < evidence.started_at || checkedAt >= expiresAt || evidence.schema_version !== db.prepare('PRAGMA schema_version').get()?.schema_version ||
      mockupifyDigest(evidenceRow(db)) !== mockupifyDigest(evidence)) {
      fail('The durability verification changed or expired during the check.');
    }
    return { admitted: true as const, startedAt: evidence.started_at, expiresAt, backupPath, recoveryPath,
      backupSha256: evidence.backup_sha256, recoverySha256: evidence.recovery_sha256 };
  } catch (error) {
    return { admitted: false as const, reason: error instanceof WorkerError ? error.message :
      'The database or verification artifacts could not be read.' };
  }
}

export async function verifyDurability(db: DatabaseSync, path: string, identity: string | null,
  directory: string, backupTo: (destination: string) => Promise<void>) {
  checkIdentity(path, identity);
  checkSchema(db);
  db.exec(evidenceSchema);
  const nonce = randomUUID();
  const startedAt = Date.now();
  // Publish an incomplete attempt first so a failed or interrupted recheck cannot leave prior admission active.
  const evidence = db.prepare(`
    INSERT OR REPLACE INTO mockupify_durability (id, version, nonce, started_at, database_identity, schema_version)
    VALUES (1, ?, ?, ?, ?, (SELECT schema_version FROM pragma_schema_version))
    RETURNING *
  `).get(evidenceVersion, nonce, startedAt, identity);
  if (!evidence) fail('Could not start a durability verification.');
  try {
    checkDatabase(db, path, identity);
    checkIntegrity(db);
    const directoryPath = mkdtempSync(join(realpathSync.native(directory), 'tees4-durability-'));
    const backupPath = join(directoryPath, 'backup.sqlite');
    const recoveryPath = join(directoryPath, 'recovery.sqlite');
    await backupTo(backupPath);
    const backupDigest = fileDigest(backupPath);

    const scratch = mkdtempSync(join(dirname(realpathSync.native(path)), '.tees4-restore-'));
    let recoveryDigest: string;
    try {
      const restorePath = join(scratch, 'restore.sqlite');
      copyFileSync(backupPath, restorePath, constants.COPYFILE_EXCL);
      if (fileDigest(restorePath) !== backupDigest) fail('The temporary restoration differs from the backup.');
      using restored = artifact(restorePath);
      checkSnapshot(restored, evidence);

      const probePath = join(scratch, 'probe.sqlite');
      recoverProbe(probePath, nonce, startedAt);
      using reopened = new DatabaseSync(probePath, { readOnly: true });
      checkProbe(reopened, nonce, startedAt);
      await sqliteBackupTo(reopened, recoveryPath);
      recoveryDigest = fileDigest(recoveryPath);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    const completed = db.prepare(`
      UPDATE mockupify_durability SET artifact_dir = ?, backup_sha256 = ?, recovery_sha256 = ? WHERE nonce = ?
    `).run(directoryPath, backupDigest, recoveryDigest, nonce);
    if (completed.changes !== 1) fail('Another durability verification superseded this attempt.');
    const status = durabilityStatus(db, path, identity);
    if (!status.admitted) fail(status.reason);
    if (status.backupPath !== backupPath) fail('Another durability verification superseded this attempt.');
    return status;
  } catch (error) {
    db.prepare('DELETE FROM mockupify_durability WHERE nonce = ?').run(nonce);
    if (error instanceof WorkerError) throw error;
    fail('The durability verification failed. Check the database and backup directory access and available disk space.');
  }
}
