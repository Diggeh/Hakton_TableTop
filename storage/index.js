import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Local asset storage. Knows nothing about Electron at import time: the caller may
 * inject the Electron `app` (or a base dir), otherwise we resolve the per-OS path.
 *
 * Layout:
 *   <appData>/hakton.db
 *   <appData>/uploads/maps     lossless battle maps
 *   <appData>/uploads/tokens   lossless token art
 *
 * Files are persisted byte-for-byte (rename/copy/write): NO decode, resize or re-encode.
 */
export const UPLOAD_SUBDIRS = ['maps', 'tokens'];
const APP_DIR_NAME = 'Hakton';

/** Hard cap per uploaded asset: 250 MB. Also pass this to the upload middleware (e.g. multer limits.fileSize). */
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

export class UploadTooLargeError extends Error {
  constructor(bytes) {
    super(`File is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    this.name = 'UploadTooLargeError';
    this.code = 'E_UPLOAD_TOO_LARGE';
    this.bytes = bytes;
  }
}

// Lossless/raster formats accepted for maps & tokens. Extension is derived here, never trusted raw.
const ALLOWED_EXT = new Set(['.png', '.webp', '.gif', '.jpg', '.jpeg', '.avif', '.bmp', '.tiff', '.svg']);

/**
 * Resolves the absolute application data directory.
 * Priority: explicit baseDir > Electron app.getPath('userData') > HAKTON_DATA_DIR > OS default.
 * OS default mirrors Electron's userData: %APPDATA%\Hakton, ~/Library/Application Support/Hakton,
 * $XDG_CONFIG_HOME|~/.config/Hakton.
 * @param {{ baseDir?: string, electronApp?: { getPath(name: string): string } }} [opts]
 */
export function resolveAppDataDir({ baseDir, electronApp } = {}) {
  if (baseDir) return path.resolve(baseDir);
  if (typeof electronApp?.getPath === 'function') return path.resolve(electronApp.getPath('userData'));
  if (process.env.HAKTON_DATA_DIR) return path.resolve(process.env.HAKTON_DATA_DIR);

  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_DIR_NAME);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_DIR_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP_DIR_NAME);
  }
}

/** Back-compat alias: accepts a base dir string (as electron/main.js passes). */
export const resolveDataDir = (baseDir) => resolveAppDataDir({ baseDir });

/**
 * Idempotent; call once on backend startup. Creates uploads/, uploads/maps, uploads/tokens
 * (existsSync check + recursive mkdir) and verifies read/write access. Throws if not writable.
 * @param {string | { baseDir?: string, electronApp?: object }} [source]
 */
export function initStorage(source) {
  const dataDir = resolveAppDataDir(typeof source === 'string' ? { baseDir: source } : source);
  const uploadsDir = path.join(dataDir, 'uploads');
  const dirs = Object.fromEntries(UPLOAD_SUBDIRS.map((k) => [k, path.join(uploadsDir, k)]));

  for (const dir of [dataDir, uploadsDir, ...Object.values(dirs)]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  fs.accessSync(uploadsDir, fs.constants.R_OK | fs.constants.W_OK);

  const assertKind = (kind) => {
    if (!UPLOAD_SUBDIRS.includes(kind)) throw new Error(`Unknown upload kind: ${kind}`);
  };

  /** Absolute path of a stored asset; rejects traversal (../, absolute names, separators). */
  function getAssetPath(kind, fileName) {
    assertKind(kind);
    const full = path.resolve(dirs[kind], String(fileName));
    if (path.dirname(full) !== dirs[kind]) throw new Error('Invalid asset file name');
    return full;
  }

  /**
   * Moves/writes an uploaded file into uploads/<kind>/ under a collision-free name
   * (`<uuid><ext>`), unmodified. Returns the name to persist in the DB.
   *
   * @param {'maps'|'tokens'} kind
   * @param {string | Buffer | Uint8Array} source temp file path (moved) or in-memory bytes (written)
   * @param {{ originalName?: string, ext?: string }} [opts] extension source (e.g. multer file.originalname)
   * @returns {Promise<{ fileName: string, path: string, bytes: number }>}
   */
  async function saveAsset(kind, source, { originalName, ext } = {}) {
    assertKind(kind);
    const extension = (ext ?? path.extname(originalName ?? (typeof source === 'string' ? source : ''))).toLowerCase();
    if (!ALLOWED_EXT.has(extension)) throw new Error(`Unsupported image type: "${extension}"`);

    const incoming = typeof source === 'string' ? (await fs.promises.stat(source)).size : source.byteLength;
    if (incoming > MAX_UPLOAD_BYTES) {
      if (typeof source === 'string') await fs.promises.unlink(source).catch(() => {}); // drop oversized temp file
      throw new UploadTooLargeError(incoming);
    }

    const fileName = `${crypto.randomUUID()}${extension}`;
    const dest = getAssetPath(kind, fileName);

    if (typeof source === 'string') {
      try {
        await fs.promises.rename(source, dest); // atomic, zero-copy on same volume
      } catch (err) {
        if (err.code !== 'EXDEV') throw err; // temp dir on another drive: copy then remove
        await fs.promises.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
        await fs.promises.unlink(source);
      }
    } else {
      await fs.promises.writeFile(dest, source, { flag: 'wx' }); // 'wx' = never overwrite
    }

    const { size } = await fs.promises.stat(dest);
    return { fileName, path: dest, bytes: size };
  }

  return {
    dataDir,
    dbPath: path.join(dataDir, 'hakton.db'),
    uploadsDir,
    dirs,
    getAssetPath,
    saveAsset,
    /** Kept for existing callers. */
    resolveUpload: getAssetPath,
    /** Best-effort delete (e.g. when a map is removed). Resolves false if already gone. */
    async deleteAsset(kind, fileName) {
      try {
        await fs.promises.unlink(getAssetPath(kind, fileName));
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    },
  };
}
