import fs from 'node:fs';
import path from 'node:path';

const BACKUP_PREFIX = 'hakton-';
let backupSequence = 0;

function stamp() {
  // Timestamp + monotonic counter: two backups in the same millisecond (easy in
  // tests) must never collide, and lexicographic sort stays creation order.
  backupSequence = (backupSequence + 1) % 10000;
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(backupSequence).padStart(4, '0')}`;
}

/**
 * Creates a consistent single-file copy of the live database using
 * `VACUUM INTO`, which works while WAL mode is active and never leaves a
 * half-written backup behind (each backup goes to a fresh timestamped name).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} backupDir
 * @param {{ keep?: number }} [opts]
 * @returns {{ path: string, bytes: number }}
 */
export function createBackup(db, backupDir, { keep = 10 } = {}) {
  fs.mkdirSync(backupDir, { recursive: true });

  const destination = path.join(backupDir, `${BACKUP_PREFIX}${stamp()}.db`);
  const escaped = destination.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  pruneBackups(backupDir, keep);
  return { path: destination, bytes: fs.statSync(destination).size };
}

/**
 * Backups newest-last, filtered to real `.db` files (never quarantined copies).
 * @param {string} backupDir
 */
export function listBackups(backupDir) {
  try {
    return fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.db'))
      .sort()
      .map((name) => path.join(backupDir, name));
  } catch {
    return [];
  }
}

/** Path of the newest backup, or null when none exist. */
export function latestBackup(backupDir) {
  const backups = listBackups(backupDir);
  return backups.length ? backups[backups.length - 1] : null;
}

/** Keeps only the newest `keep` backups. Returns the removed paths. */
export function pruneBackups(backupDir, keep = 10) {
  const backups = listBackups(backupDir);
  const safeKeep = Math.max(1, Number(keep) || 10);
  const excess = backups.slice(0, Math.max(0, backups.length - safeKeep));
  for (const file of excess) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Ignore races with another pruning pass.
    }
  }
  return excess;
}

/**
 * Starts the periodic backup timer. The returned stop function is safe to call
 * on shutdown and the timer is unref'd so it never keeps the process alive.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} backupDir
 * @param {{ intervalMs?: number, keep?: number, logger?: Console }} [opts]
 */
export function startBackupSchedule(
  db,
  backupDir,
  { intervalMs = 5 * 60 * 1000, keep = 10, logger = console } = {},
) {
  const timer = setInterval(() => {
    try {
      createBackup(db, backupDir, { keep });
    } catch (error) {
      logger?.warn?.('[hakton] periodic backup failed:', error?.message ?? error);
    }
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
