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
 *   <appData>/backups          timestamped database snapshots
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

export class InvalidAssetError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'InvalidAssetError';
    this.code = 'E_INVALID_ASSET';
    Object.assign(this, details);
  }
}

// Lossless/raster formats (plus sanitized SVG) accepted for maps & tokens.
// Extension is validated against actual binary/XML header, never trusted raw.
export const SUPPORTED_IMAGE_EXTENSIONS = Object.freeze([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
]);
const ALLOWED_EXT = new Set(SUPPORTED_IMAGE_EXTENSIONS);
const HEADER_READ_BYTES = 256 * 1024; // 256 KB covers EXIF/ICC metadata before JPEG SOF markers

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VALID_PNG_COLOR_TYPES = new Set([0, 2, 3, 4, 6]);
const VALID_PNG_BIT_DEPTHS = new Set([1, 2, 4, 8, 16]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectSvgContent(buf) {
  const text = buf.toString('utf8').trim();
  if (!text.includes('<svg') || !/<svg\b[^>]*>/i.test(text)) {
    return null;
  }
  // Reject dangerous SVG features (embedded scripts, inline event handlers, javascript: URIs, foreignObject)
  if (
    /<script\b/i.test(text) ||
    /\bon[a-z]+\s*=/i.test(text) ||
    /javascript\s*:/i.test(text) ||
    /<foreignObject\b/i.test(text)
  ) {
    throw new InvalidAssetError('Unsafe SVG content: embedded scripts or event handlers are not allowed');
  }

  const svgTagMatch = text.match(/<svg\b([^>]*)>/i);
  const attrs = svgTagMatch ? svgTagMatch[1] : '';
  const widthMatch = attrs.match(/\bwidth\s*=\s*["']\s*([0-9]+(?:\.[0-9]+)?)/i);
  const heightMatch = attrs.match(/\bheight\s*=\s*["']\s*([0-9]+(?:\.[0-9]+)?)/i);
  const viewBoxMatch = attrs.match(
    /\bviewBox\s*=\s*["']\s*[-+0-9.]+\s+[-+0-9.]+\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)/i,
  );

  const width = Math.round(Number(widthMatch?.[1] ?? viewBoxMatch?.[1] ?? 1024));
  const height = Math.round(Number(heightMatch?.[2] ?? heightMatch?.[1] ?? viewBoxMatch?.[2] ?? 1024));

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new InvalidAssetError('Corrupted SVG file: invalid dimensions');
  }

  return {
    format: 'svg',
    mimeType: 'image/svg+xml',
    width,
    height,
    canonicalExt: '.svg',
    allowedExts: ['.svg'],
  };
}

/**
 * Inspects binary image header bytes to verify format integrity and extract dimensions.
 * Rejects unsupported, truncated, unsafe, or corrupted image content.
 *
 * @param {Buffer | Uint8Array} inputBuffer header bytes (or full file buffer)
 * @param {{ totalBytes?: number, expectedExt?: string }} [opts]
 * @returns {{ format: string, mimeType: string, width: number, height: number, canonicalExt: string, allowedExts: string[] }}
 */
export function inspectImageHeader(inputBuffer, { totalBytes, expectedExt } = {}) {
  const buf = Buffer.isBuffer(inputBuffer) ? inputBuffer : Buffer.from(inputBuffer ?? []);
  const fileSize = totalBytes ?? buf.byteLength;

  if (fileSize <= 0 || buf.byteLength === 0) {
    throw new InvalidAssetError('Image file is empty');
  }

  let detected = null;

  // 1. PNG: 8-byte signature + IHDR chunk (length 13 at offset 8..12, 'IHDR' at 12..16)
  if (buf.byteLength >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) {
    if (buf.byteLength < 33 || fileSize < 45) {
      throw new InvalidAssetError('Corrupted or truncated PNG file');
    }
    const ihdrLen = buf.readUInt32BE(8);
    const ihdrTag = buf.toString('ascii', 12, 16);
    if (ihdrLen !== 13 || ihdrTag !== 'IHDR') {
      throw new InvalidAssetError('Corrupted PNG file: invalid IHDR header');
    }
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const bitDepth = buf.readUInt8(24);
    const colorType = buf.readUInt8(25);
    const compression = buf.readUInt8(26);
    const filter = buf.readUInt8(27);
    const interlace = buf.readUInt8(28);

    if (
      width <= 0 ||
      height <= 0 ||
      width > 65535 ||
      height > 65535 ||
      !VALID_PNG_BIT_DEPTHS.has(bitDepth) ||
      !VALID_PNG_COLOR_TYPES.has(colorType) ||
      compression !== 0 ||
      filter !== 0 ||
      (interlace !== 0 && interlace !== 1)
    ) {
      throw new InvalidAssetError('Corrupted PNG file: invalid image parameters');
    }

    // Verify next chunk header after IHDR (offset 33) is structurally within file bounds
    if (buf.byteLength >= 41) {
      const nextChunkLen = buf.readUInt32BE(33);
      const nextChunkType = buf.toString('ascii', 37, 41);
      if (!/^[A-Za-z]{4}$/.test(nextChunkType) || 33 + 12 + nextChunkLen > fileSize) {
        throw new InvalidAssetError('Corrupted or truncated PNG chunk structure');
      }
    }

    detected = {
      format: 'png',
      mimeType: 'image/png',
      width,
      height,
      canonicalExt: '.png',
      allowedExts: ['.png'],
    };
  }
  // 2. JPEG: starts with SOI (FF D8 FF)
  else if (buf.byteLength >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    if (buf.byteLength < 11 || fileSize < 11) {
      throw new InvalidAssetError('Corrupted or truncated JPEG file');
    }
    let offset = 2;
    while (offset < buf.byteLength) {
      if (buf[offset] !== 0xff) {
        throw new InvalidAssetError('Corrupted JPEG file: invalid marker alignment');
      }
      while (offset < buf.byteLength && buf[offset] === 0xff) offset++;
      if (offset >= buf.byteLength) break;

      const marker = buf[offset];
      offset++;

      // Standalone markers without length payload
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS reached before SOF

      if (offset + 2 > buf.byteLength) {
        throw new InvalidAssetError('Corrupted or truncated JPEG segment header');
      }
      const segLen = buf.readUInt16BE(offset);
      if (segLen < 2 || offset + segLen > fileSize) {
        throw new InvalidAssetError('Corrupted or truncated JPEG segment length');
      }

      if (JPEG_SOF_MARKERS.has(marker)) {
        if (segLen < 8 || offset + 7 > buf.byteLength) {
          throw new InvalidAssetError('Corrupted JPEG SOF frame header');
        }
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        if (width <= 0 || height <= 0) {
          throw new InvalidAssetError('Corrupted JPEG file: invalid dimensions');
        }
        detected = {
          format: 'jpeg',
          mimeType: 'image/jpeg',
          width,
          height,
          canonicalExt: '.jpg',
          allowedExts: ['.jpg', '.jpeg'],
        };
        break;
      }

      offset += segLen;
    }

    if (!detected) {
      throw new InvalidAssetError('Corrupted JPEG file: missing Start of Frame (SOF) marker');
    }
  }
  // 3. WebP: RIFF....WEBP
  else if (
    buf.byteLength >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    if (buf.byteLength < 25 || fileSize < 25) {
      throw new InvalidAssetError('Corrupted or truncated WebP file');
    }
    const riffSize = buf.readUInt32LE(4);
    if (riffSize + 8 > fileSize) {
      throw new InvalidAssetError('Corrupted or truncated WebP RIFF container');
    }
    const chunkType = buf.toString('ascii', 12, 16);
    let width = 0;
    let height = 0;

    if (chunkType === 'VP8 ') {
      if (buf.byteLength < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) {
        throw new InvalidAssetError('Corrupted WebP VP8 frame header');
      }
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunkType === 'VP8L') {
      if (buf.byteLength < 25 || buf[20] !== 0x2f) {
        throw new InvalidAssetError('Corrupted WebP VP8L lossless header');
      }
      const bits = buf.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    } else if (chunkType === 'VP8X') {
      if (buf.byteLength < 30) {
        throw new InvalidAssetError('Corrupted WebP VP8X extended header');
      }
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    } else {
      throw new InvalidAssetError(`Unsupported or corrupted WebP chunk type: "${chunkType}"`);
    }

    if (width <= 0 || height <= 0) {
      throw new InvalidAssetError('Corrupted WebP file: invalid dimensions');
    }

    detected = {
      format: 'webp',
      mimeType: 'image/webp',
      width,
      height,
      canonicalExt: '.webp',
      allowedExts: ['.webp'],
    };
  }
  // 4. GIF: GIF87a or GIF89a
  else if (
    buf.byteLength >= 6 &&
    (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    if (buf.byteLength < 14 || fileSize < 14) {
      throw new InvalidAssetError('Corrupted or truncated GIF file');
    }
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    if (width <= 0 || height <= 0) {
      throw new InvalidAssetError('Corrupted GIF file: invalid dimensions');
    }
    detected = {
      format: 'gif',
      mimeType: 'image/gif',
      width,
      height,
      canonicalExt: '.gif',
      allowedExts: ['.gif'],
    };
  }
  // 5. BMP: 'BM'
  else if (buf.byteLength >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    if (buf.byteLength < 26 || fileSize < 26) {
      throw new InvalidAssetError('Corrupted or truncated BMP file');
    }
    const declaredSize = buf.readUInt32LE(2);
    const dibSize = buf.readUInt32LE(14);
    if (declaredSize > fileSize || dibSize < 12) {
      throw new InvalidAssetError('Corrupted BMP header');
    }
    const width = dibSize === 12 ? buf.readUInt16LE(18) : buf.readInt32LE(18);
    const rawHeight = dibSize === 12 ? buf.readUInt16LE(20) : buf.readInt32LE(22);
    const height = Math.abs(rawHeight);
    if (width <= 0 || height <= 0) {
      throw new InvalidAssetError('Corrupted BMP file: invalid dimensions');
    }
    detected = {
      format: 'bmp',
      mimeType: 'image/bmp',
      width,
      height,
      canonicalExt: '.bmp',
      allowedExts: ['.bmp'],
    };
  } else {
    // 6. Sanitized SVG (used by bundled starter-map.svg and clean vector maps)
    detected = inspectSvgContent(buf);
    if (!detected) {
      throw new InvalidAssetError('Unsupported or corrupted image file content');
    }
  }

  if (expectedExt) {
    const normalizedExt = expectedExt.toLowerCase();
    if (!ALLOWED_EXT.has(normalizedExt)) {
      throw new InvalidAssetError(`Unsupported image type: "${normalizedExt}"`);
    }
    if (!detected.allowedExts.includes(normalizedExt)) {
      throw new InvalidAssetError(
        `File extension "${normalizedExt}" does not match actual image format (${detected.format})`,
      );
    }
  }

  return detected;
}

/**
 * Reads only the initial header slice of a file on disk to validate magic bytes & dimensions
 * without loading a multi-hundred-MB file into memory.
 */
async function inspectImageFile(filePath, fileSize, expectedExt) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const toRead = Math.min(fileSize, HEADER_READ_BYTES);
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, 0);
    return inspectImageHeader(buf.subarray(0, bytesRead), { totalBytes: fileSize, expectedExt });
  } finally {
    await fh.close();
  }
}

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
  const backupsDir = path.join(dataDir, 'backups');
  const dirs = Object.fromEntries(UPLOAD_SUBDIRS.map((k) => [k, path.join(uploadsDir, k)]));

  for (const dir of [dataDir, backupsDir, uploadsDir, ...Object.values(dirs)]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  fs.accessSync(uploadsDir, fs.constants.R_OK | fs.constants.W_OK);

  const assertKind = (kind) => {
    if (!UPLOAD_SUBDIRS.includes(kind)) throw new Error(`Unknown upload kind: ${kind}`);
  };

  /** Absolute path of a stored asset; rejects traversal (../, absolute names, separators, null bytes). */
  function getAssetPath(kind, fileName) {
    assertKind(kind);
    if (typeof fileName !== 'string' || !fileName.trim() || fileName.includes('\0')) {
      throw new InvalidAssetError('Invalid asset file name');
    }
    const full = path.resolve(dirs[kind], fileName);
    if (path.dirname(full) !== dirs[kind] || path.basename(full) !== fileName) {
      throw new InvalidAssetError('Invalid asset file name');
    }
    return full;
  }

  /**
   * Moves/copies/writes an uploaded file into uploads/<kind>/ under a collision-free name
   * (`<uuid><ext>`), unmodified. Validates binary image content and dimensions before writing.
   *
   * @param {'maps'|'tokens'} kind
   * @param {string | Buffer | Uint8Array} source file path or in-memory bytes
   * @param {{ originalName?: string, ext?: string, copy?: boolean }} [opts]
   *   `copy: true` copies the source file without moving or deleting the user's original file.
   * @returns {Promise<{ fileName: string, path: string, bytes: number, format: string, mimeType: string, width: number, height: number }>}
   */
  async function saveAsset(kind, source, { originalName, ext, copy = false } = {}) {
    assertKind(kind);

    const rawExt = (ext ?? path.extname(originalName ?? (typeof source === 'string' ? source : ''))).toLowerCase();
    if (rawExt && !ALLOWED_EXT.has(rawExt)) {
      throw new InvalidAssetError(`Unsupported image type: "${rawExt}"`);
    }

    let incoming = 0;
    let imageInfo = null;

    if (typeof source === 'string') {
      if (!source.trim() || source.includes('\0')) {
        throw new InvalidAssetError('Invalid source file path');
      }
      let st;
      try {
        st = await fs.promises.stat(source);
      } catch {
        throw new InvalidAssetError('Source image file does not exist or cannot be read');
      }
      if (!st.isFile()) {
        throw new InvalidAssetError('Source path is not a regular file');
      }
      incoming = st.size;
      if (incoming <= 0) {
        throw new InvalidAssetError('Image file is empty');
      }
      if (incoming > MAX_UPLOAD_BYTES) {
        if (!copy) await fs.promises.unlink(source).catch(() => {}); // drop oversized temp file only when not copying user file
        throw new UploadTooLargeError(incoming);
      }
      imageInfo = await inspectImageFile(source, incoming, rawExt || undefined);
    } else if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
      incoming = source.byteLength;
      if (incoming <= 0) {
        throw new InvalidAssetError('Image file is empty');
      }
      if (incoming > MAX_UPLOAD_BYTES) {
        throw new UploadTooLargeError(incoming);
      }
      imageInfo = inspectImageHeader(source, { totalBytes: incoming, expectedExt: rawExt || undefined });
    } else {
      throw new InvalidAssetError('Invalid upload source: expected file path or byte buffer');
    }

    const extension = rawExt || imageInfo.canonicalExt;
    const fileName = `${crypto.randomUUID()}${extension}`;
    const dest = getAssetPath(kind, fileName);

    try {
      if (typeof source === 'string') {
        if (copy) {
          await fs.promises.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
        } else {
          try {
            await fs.promises.rename(source, dest); // atomic, zero-copy on same volume
          } catch (err) {
            if (err.code !== 'EXDEV') throw err; // temp dir on another drive: copy then remove
            await fs.promises.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
            await fs.promises.unlink(source);
          }
        }
      } else {
        await fs.promises.writeFile(dest, source, { flag: 'wx' }); // 'wx' = never overwrite
      }

      const { size } = await fs.promises.stat(dest);
      return {
        fileName,
        path: dest,
        bytes: size,
        format: imageInfo.format,
        mimeType: imageInfo.mimeType,
        width: imageInfo.width,
        height: imageInfo.height,
      };
    } catch (err) {
      await fs.promises.unlink(dest).catch(() => {});
      throw err;
    }
  }

  return {
    dataDir,
    dbPath: path.join(dataDir, 'hakton.db'),
    backupsDir,
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
