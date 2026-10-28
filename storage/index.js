import fs from 'node:fs';
import path from 'node:path';

/**
 * Local file storage bootstrap. Knows nothing about Electron: the caller injects
 * the base directory (Electron: app.getPath('userData'), which already resolves
 * to %APPDATA% / ~/Library/Application Support / ~/.config per OS).
 * Standalone/dev fallback: HAKTON_DATA_DIR env var or ./.hakton-data.
 *
 * Layout:
 *   <base>/hakton.db
 *   <base>/uploads/maps     lossless battle maps (never re-encoded)
 *   <base>/uploads/tokens   lossless token art
 */
export const UPLOAD_SUBDIRS = ['maps', 'tokens'];

export function resolveDataDir(baseDir) {
  return path.resolve(baseDir ?? process.env.HAKTON_DATA_DIR ?? path.join(process.cwd(), '.hakton-data'));
}

/** Idempotent. Call once on startup. Throws if the directory is not writable. */
export function initStorage(baseDir) {
  const dataDir = resolveDataDir(baseDir);
  const uploadsDir = path.join(dataDir, 'uploads');
  const dirs = { maps: path.join(uploadsDir, 'maps'), tokens: path.join(uploadsDir, 'tokens') };

  for (const dir of [dataDir, uploadsDir, ...Object.values(dirs)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.accessSync(uploadsDir, fs.constants.R_OK | fs.constants.W_OK);

  return {
    dataDir,
    dbPath: path.join(dataDir, 'hakton.db'),
    uploadsDir,
    dirs,
    /**
     * Resolves a stored file name inside an uploads subdir; rejects path traversal.
     * @param {'maps'|'tokens'} kind
     */
    resolveUpload(kind, fileName) {
      if (!UPLOAD_SUBDIRS.includes(kind)) throw new Error(`Unknown upload kind: ${kind}`);
      const full = path.resolve(dirs[kind], fileName);
      if (path.dirname(full) !== dirs[kind]) throw new Error('Invalid upload file name');
      return full;
    },
  };
}
