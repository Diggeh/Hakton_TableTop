import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Sorted list of migration file names on disk. */
export function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Opens a raw SQLite handle with the pragmas the app relies on.
 * Does not migrate: recovery needs to inspect the file first.
 * @param {string} filePath absolute path, or ':memory:'
 */
export function openHandle(filePath) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 1000');
  return db;
}

/**
 * Opens (creating if needed) the SQLite file and applies pending migrations.
 * This module knows nothing about Electron, sockets, or React.
 * @param {string} filePath absolute path, or ':memory:'
 */
export function openDatabase(filePath) {
  const db = openHandle(filePath);
  migrate(db);
  return db;
}

/**
 * Runs a lightweight structural check. Returns false on a thrown corruption
 * error or when SQLite reports any problem row.
 * @param {import('better-sqlite3').Database} db
 */
export function integrityCheck(db) {
  try {
    const rows = db.pragma('quick_check(1)');
    if (!Array.isArray(rows) || rows.length === 0) return true;
    return rows.every((row) => {
      const value = Object.values(row)[0];
      return typeof value === 'string' && value.toLowerCase() === 'ok';
    });
  } catch {
    return false;
  }
}

/** True when the file contains at least one application table. */
export function hasApplicationTables(db) {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get();
    return (row?.total ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Migration files that have not been recorded as applied yet. */
export function pendingMigrations(db) {
  let applied = new Set();
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (table) {
      applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
    }
  } catch {
    // Treat an unreadable migration table as "everything pending".
  }
  return listMigrationFiles().filter((file) => !applied.has(file));
}

/** Applies all pending migrations, each in its own transaction. */
export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));

  for (const file of listMigrationFiles()) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
}

/** Folds the WAL back into the main file. Safe to call on a live handle. */
export function checkpoint(db) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    return true;
  } catch {
    return false;
  }
}
