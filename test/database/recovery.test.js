import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openHandle } from '../../database/index.js';
import { openDatabaseWithRecovery } from '../../database/recovery.js';
import {
  createBackup,
  latestBackup,
  listBackups,
  pruneBackups,
} from '../../database/backup.js';
import { createRepositories } from '../../database/repositories.js';

const MIGRATIONS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'database',
  'migrations',
);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hakton-recovery-'));
}

/** Builds a database that only knows migrations 001-004. */
function createLegacyDatabase(filePath) {
  const db = openHandle(filePath);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= '005') break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
  }
  return db;
}

describe('database integrity check, backups, and recovery', () => {
  let dir;
  let dbPath;
  let backupDir;

  beforeEach(() => {
    dir = tempDir();
    dbPath = path.join(dir, 'hakton.db');
    backupDir = path.join(dir, 'backups');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens a fresh database, reports a clean integrity check, and applies migrations', () => {
    const { db, recovery } = openDatabaseWithRecovery({ filePath: dbPath, backupDir });

    assert.equal(recovery.integrityOk, true);
    assert.equal(recovery.recovered, false);
    assert.equal(recovery.corruptFile, null);

    const applied = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all();
    assert.ok(applied.some((row) => row.name === '005_autosave_recovery.sql'));

    const columns = db.prepare('PRAGMA table_info(characters)').all().map((c) => c.name);
    assert.ok(columns.includes('revision'));

    db.close();
  });

  it('keeps only the newest N backups', () => {
    const { db } = openDatabaseWithRecovery({ filePath: dbPath, backupDir });

    for (let i = 0; i < 5; i += 1) {
      createBackup(db, backupDir, { keep: 3 });
    }

    assert.equal(listBackups(backupDir).length, 3);
    assert.ok(latestBackup(backupDir));
    assert.equal(pruneBackups(backupDir, 2).length, 1);
    assert.equal(listBackups(backupDir).length, 2);

    db.close();
  });

  it('quarantines a corrupt database and restores the latest backup', () => {
    const { db } = openDatabaseWithRecovery({ filePath: dbPath, backupDir });
    const repos = createRepositories(db);

    repos.characters.upsert({
      id: 'char-survivor',
      ownerId: 'demo-dm',
      name: 'Survivor',
      sheetData: { hp: { current: 9, max: 12 } },
    });
    db.pragma('wal_checkpoint(TRUNCATE)');

    createBackup(db, backupDir);
    db.close();

    // Destroy the file header so SQLite reports corruption on open.
    fs.writeFileSync(dbPath, Buffer.alloc(8192, 0xff));
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }

    const { db: recoveredDb, recovery } = openDatabaseWithRecovery({
      filePath: dbPath,
      backupDir,
    });

    assert.equal(recovery.recovered, true);
    assert.equal(recovery.integrityOk, false);
    assert.ok(recovery.backupUsed);
    assert.ok(recovery.corruptFile);

    const corruptFiles = fs
      .readdirSync(dir)
      .filter((name) => name.includes('.corrupt-'));
    assert.equal(corruptFiles.length >= 1, true, 'corrupt copy is preserved');

    const recoveredRepos = createRepositories(recoveredDb);
    const survivor = recoveredRepos.characters.get('char-survivor');
    assert.ok(survivor, 'data from the backup survived');
    assert.equal(survivor.sheet_data.hp.current, 9);

    recoveredDb.close();
  });

  it('starts a fresh database when corruption is found and no backup exists', () => {
    const { db } = openDatabaseWithRecovery({ filePath: dbPath, backupDir });
    db.close();
    fs.writeFileSync(dbPath, Buffer.alloc(8192, 0xff));
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });

    const { db: fresh, recovery } = openDatabaseWithRecovery({ filePath: dbPath, backupDir });

    assert.equal(recovery.integrityOk, false);
    assert.equal(recovery.recovered, false);
    assert.equal(recovery.backupUsed, null);
    assert.equal(recovery.freshDatabase, true);
    assert.ok(recovery.corruptFile);

    // The quarantine file still exists and the new database is usable.
    assert.ok(fs.existsSync(recovery.corruptFile));
    const repos = createRepositories(fresh);
    assert.deepEqual(repos.maps.listByCampaign(1), []);

    fresh.close();
  });

  it('takes a backup before applying pending migrations', () => {
    const legacy = createLegacyDatabase(dbPath);
    legacy.close();

    const { db, recovery } = openDatabaseWithRecovery({ filePath: dbPath, backupDir });

    assert.deepEqual(recovery.pendingBefore, [
      '005_assets.sql',
      '005_autosave_recovery.sql',
    ]);
    assert.ok(recovery.backedUpBeforeMigration);
    assert.ok(fs.existsSync(recovery.backedUpBeforeMigration));
    assert.equal(listBackups(backupDir).length, 1);

    const columns = db.prepare('PRAGMA table_info(dm_records)').all().map((c) => c.name);
    assert.ok(columns.includes('revision'));

    db.close();
  });
});
