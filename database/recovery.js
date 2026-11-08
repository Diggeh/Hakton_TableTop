import fs from 'node:fs';
import path from 'node:path';
import {
  hasApplicationTables,
  integrityCheck,
  migrate,
  openHandle,
  pendingMigrations,
} from './index.js';
import { createBackup, latestBackup } from './backup.js';

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Opens a handle and verifies it; returns null when the file is unreadable/corrupt. */
function tryOpenHealthy(filePath) {
  let db = null;
  try {
    db = openHandle(filePath);
    if (!integrityCheck(db)) {
      try {
        db.close();
      } catch {
        // Ignore close errors on a corrupt handle.
      }
      return null;
    }
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      // Ignore.
    }
    return null;
  }
}

/** Moves the database and its WAL sidecars aside. Returns the quarantine path. */
function quarantine(filePath) {
  const target = `${filePath}.corrupt-${isoStamp()}`;
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${filePath}${suffix}`;
    if (fs.existsSync(source)) {
      try {
        fs.renameSync(source, `${target}${suffix}`);
      } catch {
        // If a rename fails the recovery still proceeds; the file is left alone.
      }
    }
  }
  return target;
}

/**
 * Opens SQLite with an integrity check, automatic restore from the latest
 * backup, and a backup taken before any pending migration runs.
 *
 * Recovery is deliberately automatic: a corrupt file is preserved as
 * `hakton.db.corrupt-<timestamp>` so nothing is ever destroyed.
 *
 * @param {{
 *   filePath: string,
 *   backupDir?: string|null,
 *   logger?: Console,
 * }} opts
 * @returns {{
 *   db: import('better-sqlite3').Database,
 *   recovery: {
 *     integrityOk: boolean,
 *     recovered: boolean,
 *     backupUsed: string|null,
 *     corruptFile: string|null,
 *     freshDatabase: boolean,
 *     backedUpBeforeMigration: string|null,
 *     pendingBefore: string[],
 *   },
 * }}
 */
export function openDatabaseWithRecovery({ filePath, backupDir = null, logger = console } = {}) {
  /** @type {any} */
  const recovery = {
    integrityOk: true,
    recovered: false,
    backupUsed: null,
    corruptFile: null,
    freshDatabase: false,
    backedUpBeforeMigration: null,
    pendingBefore: [],
  };

  if (!filePath) throw new TypeError('openDatabaseWithRecovery requires a file path');

  if (filePath === ':memory:') {
    const db = openHandle(filePath);
    migrate(db);
    return { db, recovery };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (backupDir) fs.mkdirSync(backupDir, { recursive: true });

  const existed = fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  let db = null;

  if (existed) {
    db = tryOpenHealthy(filePath);

    if (!db) {
      recovery.integrityOk = false;
      recovery.corruptFile = quarantine(filePath);

      const restoreFrom = backupDir ? latestBackup(backupDir) : null;
      if (restoreFrom) {
        try {
          fs.copyFileSync(restoreFrom, filePath);
          db = tryOpenHealthy(filePath);
          if (db) {
            recovery.recovered = true;
            recovery.backupUsed = restoreFrom;
            logger?.warn?.(
              `[hakton] database recovered from ${path.basename(restoreFrom)}; corrupt copy kept at ${recovery.corruptFile}`,
            );
          }
        } catch (error) {
          logger?.warn?.('[hakton] could not restore backup:', error?.message ?? error);
        }
      }
    }
  }

  if (!db) {
    db = openHandle(filePath);
    if (existed && !recovery.recovered) recovery.freshDatabase = true;
  }

  recovery.pendingBefore = pendingMigrations(db);

  // A schema change is the riskiest moment for user data: snapshot first.
  if (recovery.pendingBefore.length > 0 && backupDir && hasApplicationTables(db)) {
    try {
      const backup = createBackup(db, backupDir);
      recovery.backedUpBeforeMigration = backup.path;
    } catch (error) {
      logger?.warn?.('[hakton] pre-migration backup failed:', error?.message ?? error);
    }
  }

  migrate(db);

  return { db, recovery };
}
