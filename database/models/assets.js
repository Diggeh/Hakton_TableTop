export const ASSET_TYPES = Object.freeze(['map', 'token']);
export const ASSET_CATEGORIES = Object.freeze(['scenes', 'characters', 'maps', 'props', 'attachments']);

const parseJson = (s) => (s == null ? {} : typeof s === 'string' ? JSON.parse(s) : s);

/**
 * Escapes SQL LIKE wildcards (%, _, \) so user search strings are matched literally.
 */
export function escapeLikePattern(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * Default catalog category for a given asset type ('map' -> 'maps', 'token' -> 'characters').
 */
export function defaultCategoryForType(type) {
  return type === 'token' ? 'characters' : 'maps';
}

function hydrate(row) {
  if (!row) return null;
  const metadata = parseJson(row.metadata);
  return {
    id: row.id,
    name: row.name,
    original_name: row.original_name,
    originalName: row.original_name,
    type: row.type,
    kind: row.type === 'token' ? 'tokens' : 'maps',
    category: row.category,
    file_name: row.file_name,
    fileName: row.file_name,
    mime_type: row.mime_type,
    mimeType: row.mime_type,
    format: row.format,
    byte_size: row.byte_size,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    campaign_id: row.campaign_id,
    campaignId: row.campaign_id,
    metadata,
    created_at: row.created_at,
    createdAt: row.created_at,
  };
}

export function createAssetModel(db) {
  const insertStmt = db.prepare(`
    INSERT INTO assets (
      id, name, original_name, type, category, file_name,
      mime_type, format, byte_size, width, height, campaign_id, metadata, created_at
    ) VALUES (
      @id, @name, @originalName, @type, @category, @fileName,
      @mimeType, @format, @byteSize, @width, @height, @campaignId, @metadata,
      COALESCE(@createdAt, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);

  const byIdStmt = db.prepare('SELECT * FROM assets WHERE id = ?');
  const byFileNameStmt = db.prepare('SELECT * FROM assets WHERE file_name = ?');

  const listStmt = db.prepare(`
    SELECT * FROM assets
    WHERE (@type IS NULL OR type = @type)
      AND (@category IS NULL OR category = @category)
      AND (@campaignId IS NULL OR campaign_id = @campaignId)
      AND (
        @searchPattern IS NULL
        OR name LIKE @searchPattern ESCAPE '\\' COLLATE NOCASE
        OR original_name LIKE @searchPattern ESCAPE '\\' COLLATE NOCASE
      )
    ORDER BY created_at DESC, rowid DESC
    LIMIT @limit OFFSET @offset`);

  const countStmt = db.prepare(`
    SELECT COUNT(*) AS total FROM assets
    WHERE (@type IS NULL OR type = @type)
      AND (@category IS NULL OR category = @category)
      AND (@campaignId IS NULL OR campaign_id = @campaignId)
      AND (
        @searchPattern IS NULL
        OR name LIKE @searchPattern ESCAPE '\\' COLLATE NOCASE
        OR original_name LIKE @searchPattern ESCAPE '\\' COLLATE NOCASE
      )`);

  const renameStmt = db.prepare('UPDATE assets SET name = @name WHERE id = @id');
  const updateCategoryStmt = db.prepare('UPDATE assets SET category = @category WHERE id = @id');
  const updateMetadataStmt = db.prepare('UPDATE assets SET metadata = @metadata WHERE id = @id');
  const deleteStmt = db.prepare('DELETE FROM assets WHERE id = ?');

  return {
    /**
     * Inserts a new asset metadata record.
     * @param {{
     *   id: string,
     *   name: string,
     *   originalName: string,
     *   type: 'map'|'token',
     *   category?: 'scenes'|'characters'|'maps'|'props'|'attachments',
     *   fileName: string,
     *   mimeType: string,
     *   format: string,
     *   byteSize: number,
     *   width: number,
     *   height: number,
     *   campaignId?: number|null,
     *   metadata?: object,
     *   createdAt?: string|null
     * }} asset
     */
    create(asset) {
      if (!asset?.id || !asset.name || !asset.originalName || !asset.type || !asset.fileName) {
        throw new TypeError('asset requires id, name, originalName, type, fileName');
      }
      if (!ASSET_TYPES.includes(asset.type)) {
        throw new TypeError(`Invalid asset type: "${asset.type}"`);
      }
      const category = asset.category ?? defaultCategoryForType(asset.type);
      if (!ASSET_CATEGORIES.includes(category)) {
        throw new TypeError(`Invalid asset category: "${category}"`);
      }

      insertStmt.run({
        id: asset.id,
        name: String(asset.name).trim(),
        originalName: String(asset.originalName).trim(),
        type: asset.type,
        category,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        format: asset.format,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
        campaignId: asset.campaignId ?? null,
        metadata: JSON.stringify(asset.metadata ?? {}),
        createdAt: asset.createdAt ?? null,
      });

      return hydrate(byIdStmt.get(asset.id));
    },

    get: (id) => (typeof id === 'string' && id ? hydrate(byIdStmt.get(id)) : null),

    getByFileName: (fileName) =>
      typeof fileName === 'string' && fileName ? hydrate(byFileNameStmt.get(fileName)) : null,

    /**
     * Lists catalog assets with optional filtering by type, category, campaignId, and search query.
     * @param {{
     *   type?: 'map'|'token'|null,
     *   category?: 'scenes'|'characters'|'maps'|'props'|'attachments'|null,
     *   campaignId?: number|null,
     *   search?: string|null,
     *   limit?: number,
     *   offset?: number
     * }} [opts]
     */
    list({ type = null, category = null, campaignId = null, search = null, limit = 200, offset = 0 } = {}) {
      const normalizedType = type && type !== 'all' ? type : null;
      const normalizedCategory = category && category !== 'all' ? category : null;
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      const safeOffset = Math.max(0, Number(offset) || 0);

      return listStmt
        .all({
          type: normalizedType,
          category: normalizedCategory,
          campaignId: campaignId ?? null,
          searchPattern: escapeLikePattern(search),
          limit: safeLimit,
          offset: safeOffset,
        })
        .map(hydrate);
    },

    count({ type = null, category = null, campaignId = null, search = null } = {}) {
      const normalizedType = type && type !== 'all' ? type : null;
      const normalizedCategory = category && category !== 'all' ? category : null;
      const row = countStmt.get({
        type: normalizedType,
        category: normalizedCategory,
        campaignId: campaignId ?? null,
        searchPattern: escapeLikePattern(search),
      });
      return row?.total ?? 0;
    },

    rename(id, name) {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) throw new TypeError('Asset name cannot be empty');
      const changed = renameStmt.run({ id, name: trimmed }).changes > 0;
      return changed ? hydrate(byIdStmt.get(id)) : null;
    },

    setCategory(id, category) {
      if (!ASSET_CATEGORIES.includes(category)) {
        throw new TypeError(`Invalid asset category: "${category}"`);
      }
      const changed = updateCategoryStmt.run({ id, category }).changes > 0;
      return changed ? hydrate(byIdStmt.get(id)) : null;
    },

    updateMetadata(id, patch) {
      const existing = byIdStmt.get(id);
      if (!existing) return null;
      const merged = { ...parseJson(existing.metadata), ...(patch ?? {}) };
      updateMetadataStmt.run({ id, metadata: JSON.stringify(merged) });
      return hydrate(byIdStmt.get(id));
    },

    /**
     * Deletes an asset metadata row and returns the deleted hydrated record (or null if not found).
     */
    remove: db.transaction((id) => {
      const existing = hydrate(byIdStmt.get(id));
      if (!existing) return null;
      deleteStmt.run(id);
      return existing;
    }),
  };
}
