import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { InvalidAssetError, UploadTooLargeError } from '../storage/index.js';
import { ASSET_CATEGORIES, ASSET_TYPES, defaultCategoryForType } from '../database/models/assets.js';

export class AssetNotFoundError extends Error {
  constructor(id) {
    super(`Asset not found: "${id}"`);
    this.name = 'AssetNotFoundError';
    this.code = 'E_ASSET_NOT_FOUND';
    this.assetId = id;
  }
}

const CATEGORY_TO_DEFAULT_TYPE = Object.freeze({
  scenes: 'map',
  maps: 'map',
  attachments: 'map',
  characters: 'token',
  props: 'token',
});

/**
 * Normalizes caller-supplied type ('map'|'maps'|'token'|'tokens') or infers from category.
 * @returns {'map'|'token'}
 */
export function normalizeAssetType(type, category) {
  if (typeof type === 'string') {
    const lower = type.trim().toLowerCase();
    if (lower === 'map' || lower === 'maps') return 'map';
    if (lower === 'token' || lower === 'tokens') return 'token';
    throw new InvalidAssetError(`Invalid asset type: "${type}". Expected "map" or "token".`);
  }
  if (typeof category === 'string') {
    const inferred = CATEGORY_TO_DEFAULT_TYPE[category.trim().toLowerCase()];
    if (inferred) return inferred;
  }
  throw new InvalidAssetError('Asset type ("map" or "token") is required');
}

/**
 * Maps normalized asset type ('map'|'token') to storage subdirectory ('maps'|'tokens').
 * @param {'map'|'token'} type
 * @returns {'maps'|'tokens'}
 */
export function typeToStorageKind(type) {
  return type === 'token' ? 'tokens' : 'maps';
}

/**
 * Normalizes and validates catalog category ('scenes'|'characters'|'maps'|'props'|'attachments').
 */
export function normalizeAssetCategory(category, type) {
  if (category == null || category === '') {
    return defaultCategoryForType(type);
  }
  const lower = String(category).trim().toLowerCase();
  if (!ASSET_CATEGORIES.includes(lower)) {
    throw new InvalidAssetError(
      `Invalid asset category: "${category}". Expected one of: ${ASSET_CATEGORIES.join(', ')}`,
    );
  }
  return lower;
}

/**
 * Sanitizes an untrusted original filename (strips directory components and control characters).
 */
export function sanitizeFileName(rawName, fallbackExt = '') {
  const cleaned = String(rawName ?? '')
    .replace(/\0/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .trim();
  const base = path.posix.basename(cleaned.replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') {
    return `asset${fallbackExt}`;
  }
  return base;
}

/**
 * Derives a human-readable display name from an explicit name or original filename.
 */
export function deriveDisplayName(explicitName, originalName) {
  const cleanedExplicit = String(explicitName ?? '')
    .replace(/[\0\r\n\t]/g, ' ')
    .trim();
  if (cleanedExplicit) return cleanedExplicit.slice(0, 200);

  const ext = path.extname(originalName);
  const stem = path.basename(originalName, ext).trim();
  return (stem || 'Untitled Asset').slice(0, 200);
}

/**
 * Converts an Error into a structured, renderer-safe error object.
 */
export function toStructuredError(err) {
  if (err instanceof UploadTooLargeError) {
    return { code: err.code, message: err.message, bytes: err.bytes };
  }
  if (err instanceof InvalidAssetError || err instanceof AssetNotFoundError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof TypeError) {
    return { code: 'E_INVALID_INPUT', message: err.message };
  }
  return {
    code: err?.code && typeof err.code === 'string' ? err.code : 'E_ASSET_OPERATION_FAILED',
    message: err?.message || 'An unexpected asset storage error occurred',
  };
}

/**
 * Creates the coordinated Asset Management service bridging local file storage and SQLite metadata.
 *
 * @param {{
 *   storage: ReturnType<typeof import('../storage/index.js').initStorage>,
 *   repos: ReturnType<typeof import('../database/repositories.js').createRepositories>,
 *   getBaseUrl?: () => string | null
 * }} deps
 */
export function createAssetService({ storage, repos, getBaseUrl = () => null }) {
  if (!storage || !repos?.assets) {
    throw new Error('createAssetService requires initialized storage and repos.assets');
  }

  function enrichAsset(asset) {
    if (!asset) return null;
    const base = typeof getBaseUrl === 'function' ? getBaseUrl() : null;
    const relativeUrl = `/assets/${encodeURIComponent(asset.id)}/file`;
    return {
      ...asset,
      url: base ? `${base.replace(/\/$/, '')}${relativeUrl}` : relativeUrl,
    };
  }

  /**
   * Validates and imports a local image file into managed storage and records metadata in SQLite.
   * By default (`copy: true`), copies the user's file without moving or deleting the source file.
   */
  async function uploadFromPath({
    type,
    category,
    filePath,
    originalName,
    name,
    campaignId = null,
    metadata = {},
    copy = true,
  } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
      throw new InvalidAssetError('A valid source file path is required');
    }

    const normalizedType = normalizeAssetType(type, category);
    const normalizedCategory = normalizeAssetCategory(category, normalizedType);
    const kind = typeToStorageKind(normalizedType);

    const resolvedSource = path.resolve(filePath);
    const safeOriginalName = sanitizeFileName(originalName ?? path.basename(resolvedSource));
    const displayName = deriveDisplayName(name, safeOriginalName);

    const saved = await storage.saveAsset(kind, resolvedSource, {
      originalName: safeOriginalName,
      copy: copy !== false,
    });

    try {
      const record = repos.assets.create({
        id: crypto.randomUUID(),
        name: displayName,
        originalName: safeOriginalName,
        type: normalizedType,
        category: normalizedCategory,
        fileName: saved.fileName,
        mimeType: saved.mimeType,
        format: saved.format,
        byteSize: saved.bytes,
        width: saved.width,
        height: saved.height,
        campaignId,
        metadata,
      });
      return enrichAsset(record);
    } catch (dbErr) {
      await storage.deleteAsset(kind, saved.fileName).catch(() => {});
      throw dbErr;
    }
  }

  /**
   * Batch upload for multiple filesystem paths (e.g. multi-select native file dialog).
   * Valid files succeed independently; invalid files are reported in `failed`.
   */
  async function uploadManyFromPaths({
    type,
    category,
    filePaths,
    campaignId = null,
    metadata = {},
    copy = true,
  } = {}) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new InvalidAssetError('At least one file path must be provided');
    }

    const uploaded = [];
    const failed = [];

    for (const filePath of filePaths) {
      try {
        const asset = await uploadFromPath({
          type,
          category,
          filePath,
          campaignId,
          metadata,
          copy,
        });
        uploaded.push(asset);
      } catch (err) {
        failed.push({
          filePath: typeof filePath === 'string' ? path.basename(filePath) : String(filePath),
          error: toStructuredError(err),
        });
      }
    }

    return { uploaded, failed };
  }

  /**
   * Validates and saves an in-memory image buffer (`Buffer`, `Uint8Array`, or `ArrayBuffer`).
   */
  async function uploadFromBuffer({
    type,
    category,
    buffer,
    originalName,
    name,
    campaignId = null,
    metadata = {},
  } = {}) {
    const normalizedType = normalizeAssetType(type, category);
    const normalizedCategory = normalizeAssetCategory(category, normalizedType);
    const kind = typeToStorageKind(normalizedType);

    let bytes = null;
    if (Buffer.isBuffer(buffer)) {
      bytes = buffer;
    } else if (buffer instanceof Uint8Array) {
      bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (buffer instanceof ArrayBuffer) {
      bytes = Buffer.from(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
      bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      throw new InvalidAssetError('Invalid upload buffer: expected Buffer, Uint8Array, or ArrayBuffer');
    }

    const safeOriginalName = sanitizeFileName(originalName);
    const displayName = deriveDisplayName(name, safeOriginalName);
    const explicitExt = originalName ? path.extname(safeOriginalName) : undefined;

    const saved = await storage.saveAsset(kind, bytes, {
      originalName: originalName ? safeOriginalName : undefined,
      ext: explicitExt || undefined,
    });

    const finalOriginalName = originalName
      ? safeOriginalName
      : `${path.basename(safeOriginalName, path.extname(safeOriginalName))}${path.extname(saved.fileName)}`;

    try {
      const record = repos.assets.create({
        id: crypto.randomUUID(),
        name: displayName,
        originalName: finalOriginalName,
        type: normalizedType,
        category: normalizedCategory,
        fileName: saved.fileName,
        mimeType: saved.mimeType,
        format: saved.format,
        byteSize: saved.bytes,
        width: saved.width,
        height: saved.height,
        campaignId,
        metadata,
      });
      return enrichAsset(record);
    } catch (dbErr) {
      await storage.deleteAsset(kind, saved.fileName).catch(() => {});
      throw dbErr;
    }
  }

  /**
   * Batch upload for multiple in-memory file payloads (e.g. drag-and-drop or `<input type="file" multiple>`).
   */
  async function uploadManyFromBuffers({
    type,
    category,
    files,
    campaignId = null,
    metadata = {},
  } = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new InvalidAssetError('At least one file payload must be provided');
    }

    const uploaded = [];
    const failed = [];

    for (const item of files) {
      try {
        const asset = await uploadFromBuffer({
          type: item?.type ?? type,
          category: item?.category ?? category,
          buffer: item?.data ?? item?.buffer ?? item?.bytes,
          originalName: item?.originalName ?? item?.name,
          name: item?.displayName ?? item?.title,
          campaignId: item?.campaignId ?? campaignId,
          metadata: item?.metadata ?? metadata,
        });
        uploaded.push(asset);
      } catch (err) {
        failed.push({
          originalName: sanitizeFileName(item?.originalName ?? item?.name ?? 'unknown'),
          error: toStructuredError(err),
        });
      }
    }

    return { uploaded, failed };
  }

  function listAssets(filters = {}) {
    const typeFilter =
      filters?.type && filters.type !== 'all' ? normalizeAssetType(filters.type) : null;
    const categoryFilter =
      filters?.category && filters.category !== 'all'
        ? normalizeAssetCategory(filters.category, typeFilter ?? 'map')
        : null;

    return repos.assets
      .list({
        type: typeFilter,
        category: categoryFilter,
        campaignId: filters?.campaignId ?? null,
        search: filters?.search ?? null,
        limit: filters?.limit,
        offset: filters?.offset,
      })
      .map(enrichAsset);
  }

  function countAssets(filters = {}) {
    const typeFilter =
      filters?.type && filters.type !== 'all' ? normalizeAssetType(filters.type) : null;
    const categoryFilter =
      filters?.category && filters.category !== 'all'
        ? normalizeAssetCategory(filters.category, typeFilter ?? 'map')
        : null;

    return repos.assets.count({
      type: typeFilter,
      category: categoryFilter,
      campaignId: filters?.campaignId ?? null,
      search: filters?.search ?? null,
    });
  }

  function getAsset(id) {
    if (typeof id !== 'string' || !id.trim()) return null;
    return enrichAsset(repos.assets.get(id.trim()));
  }

  function renameAsset(id, name) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new InvalidAssetError('Asset ID is required');
    }
    const cleaned = String(name ?? '')
      .replace(/[\0\r\n\t]/g, ' ')
      .trim();
    if (!cleaned) {
      throw new InvalidAssetError('Asset name cannot be empty');
    }
    const updated = repos.assets.rename(id.trim(), cleaned.slice(0, 200));
    if (!updated) throw new AssetNotFoundError(id);
    return enrichAsset(updated);
  }

  function setAssetCategory(id, category) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new InvalidAssetError('Asset ID is required');
    }
    const existing = repos.assets.get(id.trim());
    if (!existing) throw new AssetNotFoundError(id);
    const normalizedCategory = normalizeAssetCategory(category, existing.type);
    return enrichAsset(repos.assets.setCategory(id.trim(), normalizedCategory));
  }

  function updateAssetMetadata(id, patch) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new InvalidAssetError('Asset ID is required');
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new InvalidAssetError('Metadata patch must be a plain object');
    }
    const updated = repos.assets.updateMetadata(id.trim(), patch);
    if (!updated) throw new AssetNotFoundError(id);
    return enrichAsset(updated);
  }

  /**
   * Deletes an asset from SQLite and removes its physical file from uploads/<kind>.
   */
  async function deleteAsset(id) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new InvalidAssetError('Asset ID is required');
    }
    const trimmedId = id.trim();
    const existing = repos.assets.get(trimmedId);
    if (!existing) {
      throw new AssetNotFoundError(trimmedId);
    }

    const kind = typeToStorageKind(existing.type);
    const removed = repos.assets.remove(trimmedId);
    const fileDeleted = await storage.deleteAsset(kind, existing.fileName);

    return {
      deleted: true,
      id: trimmedId,
      fileDeleted,
      asset: enrichAsset(removed),
    };
  }

  /**
   * Resolves and verifies the on-disk file for a stored asset ID (used for secure preview streaming).
   */
  async function resolveAssetFile(id) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new AssetNotFoundError(String(id ?? ''));
    }
    const asset = repos.assets.get(id.trim());
    if (!asset) {
      throw new AssetNotFoundError(id);
    }
    const kind = typeToStorageKind(asset.type);
    const filePath = storage.getAssetPath(kind, asset.fileName);

    try {
      const st = await fs.promises.stat(filePath);
      if (!st.isFile()) throw new Error('Not a regular file');
    } catch {
      throw new AssetNotFoundError(id);
    }

    return { asset: enrichAsset(asset), filePath };
  }

  return {
    uploadFromPath,
    uploadManyFromPaths,
    uploadFromBuffer,
    uploadManyFromBuffers,
    listAssets,
    countAssets,
    getAsset,
    renameAsset,
    setAssetCategory,
    updateAssetMetadata,
    deleteAsset,
    resolveAssetFile,
  };
}
