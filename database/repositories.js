import { randomUUID } from 'node:crypto';
import { createCharacterModel } from './models/characters.js';
import { createCompendiumModel } from './models/compendium.js';
import { createChatModel } from './models/chat.js';
import { createDmRecordModel } from './models/dmRecords.js';
import { createAssetModel } from './models/assets.js';
import { createBoardModel } from './models/board.js';
import { createSessionModel } from './models/sessions.js';
import { createAutosaveReceiptModel } from './models/autosaveReceipts.js';
import { createUserModel } from './models/users.js';
import { createNotesModel } from './models/notes.js';
import {
  DEFAULT_GRID_SIZE,
  MAX_GRID_SIZE,
  MIN_GRID_SIZE,
} from '../shared/events.js';
import { normalizeOwnerRole } from '../shared/combat.js';

const DEFAULT_MAP_WIDTH = 1920;
const DEFAULT_MAP_HEIGHT = 1080;

function clampGridSize(value, fallback = DEFAULT_GRID_SIZE) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, Math.round(n)));
}

function serializeSceneData(sceneData) {
  if (!sceneData || typeof sceneData !== 'object') return '{}';
  const normalized = {
    fogShapes: Array.isArray(sceneData.fogShapes) ? sceneData.fogShapes : [],
    walls: Array.isArray(sceneData.walls) ? sceneData.walls : [],
  };
  return JSON.stringify(normalized);
}

/**
 * Repository layer: the ONLY place SQL lives. The backend consumes these
 * plain-object methods and never touches the better-sqlite3 handle.
 */
export function createRepositories(db) {
  const tokenColumns =
    'id, map_id, label, x, y, owner_id, owner_role, locked, color, is_map, image_url, width, height, light, rotation, combat';

  const serializeJson = (value) => {
    if (!value || typeof value !== 'object') return null;
    return JSON.stringify(value);
  };

  const normalizeRotation = (val) => {
    const n = Number(val);
    return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
  };

  const stmts = {
    insertCampaign: db.prepare(
      'INSERT INTO campaigns (name, campaign_key) VALUES (?, ?)',
    ),
    insertFullCampaign: db.prepare(`
      INSERT INTO campaigns (name, campaign_key, system, description, chapter, cover_photo, sessions, updated_at)
      VALUES (@name, @campaignKey, @system, @description, @chapter, @coverPhoto, @sessions, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    listCampaigns: db.prepare('SELECT * FROM campaigns ORDER BY id ASC'),
    campaignById: db.prepare('SELECT * FROM campaigns WHERE id = ?'),
    campaignByKey: db.prepare('SELECT * FROM campaigns WHERE campaign_key = ?'),
    updateCampaignName: db.prepare('UPDATE campaigns SET name = ? WHERE id = ?'),
    clearCampaignActiveMap: db.prepare(
      'UPDATE campaigns SET active_map_id = NULL WHERE id = ?',
    ),
    deleteCampaign: db.prepare('DELETE FROM campaigns WHERE id = ?'),
    firstMap: db.prepare('SELECT * FROM maps ORDER BY id LIMIT 1'),
    mapById: db.prepare('SELECT * FROM maps WHERE id = ?'),
    mapByName: db.prepare(
      'SELECT * FROM maps WHERE campaign_id = ? AND lower(trim(name)) = lower(trim(?)) ORDER BY id LIMIT 1',
    ),
    mapsByCampaign: db.prepare('SELECT * FROM maps WHERE campaign_id = ? ORDER BY id'),
    activeMap: db.prepare(
      'SELECT m.* FROM maps m JOIN campaigns c ON c.active_map_id = m.id ORDER BY m.id LIMIT 1',
    ),
    activeMapForCampaign: db.prepare(
      'SELECT m.* FROM maps m JOIN campaigns c ON c.active_map_id = m.id WHERE c.id = ? LIMIT 1',
    ),
    insertMap: db.prepare(`
      INSERT INTO maps (campaign_id, name, grid_size, width, height, image_file, scene_data)
      VALUES (@campaignId, @name, @gridSize, @width, @height, @imageFile, @sceneData)`),
    deleteMap: db.prepare('DELETE FROM maps WHERE id = ?'),
    clearActiveMapByMapId: db.prepare(
      'UPDATE campaigns SET active_map_id = NULL WHERE active_map_id = ?',
    ),
    setActiveMap: db.prepare('UPDATE campaigns SET active_map_id = ? WHERE id = ?'),
    setMapImage: db.prepare('UPDATE maps SET image_file = ? WHERE id = ?'),
    tokensByMap: db.prepare(
      `SELECT ${tokenColumns} FROM tokens WHERE map_id = ? ORDER BY rowid`,
    ),
    tokenById: db.prepare(`SELECT ${tokenColumns} FROM tokens WHERE id = ?`),
    insertToken: db.prepare(`
      INSERT INTO tokens (id, map_id, label, x, y, owner_id, owner_role, locked, color, is_map, image_url, width, height, light, rotation, combat)
      VALUES (@id, @mapId, @label, @x, @y, @ownerId, @ownerRole, @locked, @color, @isMap, @imageUrl, @width, @height, @light, @rotation, @combat)`),
    upsertToken: db.prepare(`
      INSERT INTO tokens (id, map_id, label, x, y) VALUES (@id, @mapId, @label, @x, @y)
      ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y`),
    deleteToken: db.prepare('DELETE FROM tokens WHERE id = ?'),
    moveToken: db.prepare('UPDATE tokens SET x = @x, y = @y WHERE id = @id'),
  };

  const createMapRow = ({
    campaignId,
    name = 'Untitled Scene',
    gridSize = DEFAULT_GRID_SIZE,
    width = DEFAULT_MAP_WIDTH,
    height = DEFAULT_MAP_HEIGHT,
    imageFile = null,
    sceneData = {},
  }) => {
    const cleanName = typeof name === 'string' && name.trim() ? name.trim() : 'Untitled Scene';
    const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.round(Number(width)) : DEFAULT_MAP_WIDTH;
    const h = Number.isFinite(Number(height)) && Number(height) > 0 ? Math.round(Number(height)) : DEFAULT_MAP_HEIGHT;
    const { lastInsertRowid: mapId } = stmts.insertMap.run({
      campaignId,
      name: cleanName,
      gridSize: clampGridSize(gridSize),
      width: w,
      height: h,
      imageFile: typeof imageFile === 'string' && imageFile ? imageFile : null,
      sceneData: serializeSceneData(sceneData),
    });
    return stmts.mapById.get(mapId);
  };

  const hydrateCampaign = (row) => {
    if (!row) return null;
    const activeMap =
      stmts.activeMapForCampaign.get(row.id) ??
      stmts.mapsByCampaign.all(row.id)[0] ??
      null;
    return {
      id: row.campaign_key || `camp-${row.id}`,
      dbId: row.id,
      name: row.name,
      system: row.system || 'D&D 5e',
      description: row.description || '',
      chapter: row.chapter || 'Chapter I',
      coverPhoto: row.cover_photo || '',
      sessions: Math.max(0, Number(row.sessions) || 0),
      scene: activeMap?.name || 'Untitled Scene',
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  };

  const resolveCampaignRow = (idOrKey) => {
    if (typeof idOrKey === 'number' && Number.isInteger(idOrKey)) {
      return stmts.campaignById.get(idOrKey) ?? null;
    }
    const clean = typeof idOrKey === 'string' ? idOrKey.trim() : '';
    if (!clean) return null;
    const byKey = stmts.campaignByKey.get(clean);
    if (byKey) return byKey;
    const prefixed = clean.match(/^camp-(\d+)$/);
    if (prefixed) return stmts.campaignById.get(Number(prefixed[1])) ?? null;
    if (/^\d+$/.test(clean)) return stmts.campaignById.get(Number(clean)) ?? null;
    return null;
  };

  const campaigns = {
    get: (id) => stmts.campaignById.get(id) ?? null,
    findByKey: (campaignKey) =>
      typeof campaignKey === 'string' && campaignKey.trim()
        ? stmts.campaignByKey.get(campaignKey.trim()) ?? null
        : null,
    list: () => stmts.listCampaigns.all().map(hydrateCampaign),
    create: ({
      id,
      name,
      system = 'D&D 5e',
      description = '',
      chapter = 'Chapter I',
      coverPhoto = '',
      sessions = 0,
    } = {}) =>
      db.transaction(() => {
        const cleanName =
          typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : '';
        if (!cleanName) throw new TypeError('Campaign name is required');
        const campaignKey =
          typeof id === 'string' && id.trim() ? id.trim().slice(0, 80) : randomUUID();
        const existing = stmts.campaignByKey.get(campaignKey);
        if (existing) return hydrateCampaign(existing);
        const { lastInsertRowid: campaignId } = stmts.insertFullCampaign.run({
          name: cleanName,
          campaignKey,
          system: typeof system === 'string' && system.trim() ? system.trim() : 'D&D 5e',
          description: typeof description === 'string' ? description.slice(0, 400) : '',
          chapter: typeof chapter === 'string' && chapter.trim() ? chapter.trim() : 'Chapter I',
          coverPhoto: typeof coverPhoto === 'string' && coverPhoto ? coverPhoto : null,
          sessions: Math.max(0, Math.round(Number(sessions) || 0)),
        });
        const map = createMapRow({ campaignId, name: 'Untitled Scene' });
        stmts.setActiveMap.run(map.id, campaignId);
        return hydrateCampaign(stmts.campaignById.get(campaignId));
      })(),
    update: (idOrKey, patch = {}) => {
      const existing = resolveCampaignRow(idOrKey);
      if (!existing) return null;
      const assignments = ["updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"];
      const params = { id: existing.id };
      if (typeof patch.name === 'string' && patch.name.trim()) {
        assignments.push('name = @name');
        params.name = patch.name.trim().slice(0, 60);
      }
      if (typeof patch.system === 'string' && patch.system.trim()) {
        assignments.push('system = @system');
        params.system = patch.system.trim();
      }
      if (typeof patch.description === 'string') {
        assignments.push('description = @description');
        params.description = patch.description.slice(0, 400);
      }
      if (typeof patch.chapter === 'string' && patch.chapter.trim()) {
        assignments.push('chapter = @chapter');
        params.chapter = patch.chapter.trim();
      }
      if ('coverPhoto' in patch) {
        assignments.push('cover_photo = @coverPhoto');
        params.coverPhoto =
          typeof patch.coverPhoto === 'string' && patch.coverPhoto
            ? patch.coverPhoto
            : null;
      }
      if ('sessions' in patch) {
        assignments.push('sessions = @sessions');
        params.sessions = Math.max(0, Math.round(Number(patch.sessions) || 0));
      }
      db.prepare(`UPDATE campaigns SET ${assignments.join(', ')} WHERE id = @id`).run(
        params,
      );
      return hydrateCampaign(stmts.campaignById.get(existing.id));
    },
    delete: (idOrKey) =>
      db.transaction(() => {
        const existing = resolveCampaignRow(idOrKey);
        if (!existing) return false;
        stmts.clearCampaignActiveMap.run(existing.id);
        return stmts.deleteCampaign.run(existing.id).changes > 0;
      })(),
    ensureByKey: (campaignKey, campaignName = 'Campaign') =>
      db.transaction(() => {
        const key = typeof campaignKey === 'string' ? campaignKey.trim() : '';
        if (!key) return null;
        let campaign = stmts.campaignByKey.get(key) ?? null;
        const cleanName =
          typeof campaignName === 'string' && campaignName.trim()
            ? campaignName.trim()
            : 'Campaign';
        if (!campaign) {
          const { lastInsertRowid: campaignId } = stmts.insertCampaign.run(cleanName, key);
          const map = createMapRow({ campaignId, name: 'Untitled Scene' });
          stmts.setActiveMap.run(map.id, campaignId);
          campaign = stmts.campaignById.get(campaignId);
          return { campaign, activeMap: map };
        }
        if (cleanName && campaign.name !== cleanName) {
          stmts.updateCampaignName.run(cleanName, campaign.id);
          campaign = stmts.campaignById.get(campaign.id);
        }
        let activeMap =
          stmts.activeMapForCampaign.get(campaign.id) ??
          stmts.mapsByCampaign.all(campaign.id)[0] ??
          null;
        if (!activeMap) {
          activeMap = createMapRow({ campaignId: campaign.id, name: 'Untitled Scene' });
          stmts.setActiveMap.run(activeMap.id, campaign.id);
        } else if (campaign.active_map_id !== activeMap.id) {
          stmts.setActiveMap.run(activeMap.id, campaign.id);
        }
        return { campaign, activeMap };
      })(),
  };

  const maps = {
    first: () => stmts.firstMap.get() ?? null,
    get: (id) => stmts.mapById.get(id) ?? null,
    findByName: (campaignId, name) =>
      typeof name === 'string' && name.trim() && campaignId != null
        ? stmts.mapByName.get(campaignId, name.trim()) ?? null
        : null,
    /** The campaign's explicitly selected map, falling back to the first map. */
    active: () => stmts.activeMap.get() ?? stmts.firstMap.get() ?? null,
    activeForCampaign: (campaignId) =>
      stmts.activeMapForCampaign.get(campaignId) ??
      stmts.mapsByCampaign.all(campaignId)[0] ??
      null,
    listByCampaign: (campaignId) => stmts.mapsByCampaign.all(campaignId),
    setActive: (campaignId, mapId) =>
      stmts.setActiveMap.run(mapId, campaignId).changes > 0,
    create: createMapRow,
    /** Creates a campaign + map. Returns the map row. */
    createWithCampaign: (campaignName, mapName = 'Untitled Scene', opts = {}) =>
      db.transaction(() => {
        const key =
          typeof opts?.campaignKey === 'string' && opts.campaignKey.trim()
            ? opts.campaignKey.trim()
            : null;
        const { lastInsertRowid: campaignId } = stmts.insertCampaign.run(campaignName, key);
        const map = createMapRow({
          campaignId,
          name: mapName,
          gridSize: opts?.gridSize ?? DEFAULT_GRID_SIZE,
          width: opts?.width ?? DEFAULT_MAP_WIDTH,
          height: opts?.height ?? DEFAULT_MAP_HEIGHT,
        });
        stmts.setActiveMap.run(map.id, campaignId);
        return stmts.mapById.get(map.id);
      })(),
    update: (id, patch = {}) => {
      const existing = stmts.mapById.get(id);
      if (!existing) return null;
      const params = { id };
      const assignments = [];
      if (typeof patch.name === 'string' && patch.name.trim()) {
        params.name = patch.name.trim().slice(0, 80);
        assignments.push('name = @name');
      }
      if ('gridSize' in patch) {
        params.gridSize = clampGridSize(patch.gridSize, existing.grid_size ?? DEFAULT_GRID_SIZE);
        assignments.push('grid_size = @gridSize');
      }
      if ('width' in patch) {
        const w = Number(patch.width);
        if (Number.isFinite(w) && w > 0) {
          params.width = Math.round(w);
          assignments.push('width = @width');
        }
      }
      if ('height' in patch) {
        const h = Number(patch.height);
        if (Number.isFinite(h) && h > 0) {
          params.height = Math.round(h);
          assignments.push('height = @height');
        }
      }
      if ('imageFile' in patch) {
        params.imageFile = typeof patch.imageFile === 'string' && patch.imageFile ? patch.imageFile : null;
        assignments.push('image_file = @imageFile');
      }
      if ('sceneData' in patch) {
        params.sceneData = serializeSceneData(patch.sceneData);
        assignments.push('scene_data = @sceneData');
      }
      if (assignments.length === 0) return existing;
      db.prepare(`UPDATE maps SET ${assignments.join(', ')} WHERE id = @id`).run(params);
      return stmts.mapById.get(id);
    },
    delete: (id) =>
      db.transaction(() => {
        const existing = stmts.mapById.get(id);
        if (!existing) return { deleted: false, activeMap: null };
        const campaignId = existing.campaign_id;
        stmts.clearActiveMapByMapId.run(id);
        const deleted = stmts.deleteMap.run(id).changes > 0;
        let activeMap =
          stmts.activeMapForCampaign.get(campaignId) ??
          stmts.mapsByCampaign.all(campaignId)[0] ??
          null;
        if (!activeMap) {
          activeMap = createMapRow({ campaignId, name: 'Untitled Scene' });
        }
        stmts.setActiveMap.run(activeMap.id, campaignId);
        return { deleted, activeMap };
      })(),
    setImage: (mapId, fileName) =>
      stmts.setMapImage.run(fileName, mapId).changes > 0,
  };

  return {
    characters: createCharacterModel(db),
    compendium: createCompendiumModel(db),
    chat: createChatModel(db),
    dmRecords: createDmRecordModel(db),
    assets: createAssetModel(db),
    board: createBoardModel(db),
    sessions: createSessionModel(db),
    autosaveReceipts: createAutosaveReceiptModel(db),
    users: createUserModel(db),
    notes: createNotesModel(db),
    campaigns,
    maps,
    tokens: {
      listByMap: (mapId) => stmts.tokensByMap.all(mapId),
      get: (id) => stmts.tokenById.get(id) ?? null,
      upsert: (token) => stmts.upsertToken.run(token),
      create: ({
        id,
        mapId,
        label,
        x = 0,
        y = 0,
        ownerId = null,
        ownerRole = null,
        locked = false,
        color = null,
        isMap = false,
        imageUrl = null,
        width = null,
        height = null,
        light = null,
        rotation = 0,
        combat = null,
      }) => {
        stmts.insertToken.run({
          id,
          mapId,
          label,
          x,
          y,
          ownerId,
          ownerRole: normalizeOwnerRole(ownerRole),
          locked: locked ? 1 : 0,
          color,
          isMap: isMap ? 1 : 0,
          imageUrl: typeof imageUrl === 'string' && imageUrl ? imageUrl : null,
          width: Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : null,
          height: Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : null,
          light: serializeJson(light),
          rotation: normalizeRotation(rotation),
          combat: serializeJson(combat),
        });
        return stmts.tokenById.get(id);
      },
      update: (id, patch = {}) => {
        const columns = {
          label: 'label',
          ownerId: 'owner_id',
          ownerRole: 'owner_role',
          locked: 'locked',
          color: 'color',
          isMap: 'is_map',
          imageUrl: 'image_url',
          width: 'width',
          height: 'height',
          light: 'light',
          rotation: 'rotation',
          combat: 'combat',
        };
        const fields = Object.keys(columns).filter((key) => key in patch);
        if (fields.length === 0) return stmts.tokenById.get(id) ?? null;

        const params = { id };
        for (const field of fields) {
          const value = patch[field];
          if (field === 'locked' || field === 'isMap') {
            params[field] = value ? 1 : 0;
          } else if (field === 'width' || field === 'height') {
            params[field] =
              Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
          } else if (field === 'light' || field === 'combat') {
            params[field] = serializeJson(value);
          } else if (field === 'rotation') {
            params[field] = normalizeRotation(value);
          } else if (field === 'ownerRole') {
            params[field] = normalizeOwnerRole(value);
          } else {
            params[field] = value === undefined ? null : value;
          }
        }
        const assignments = fields
          .map((field) => `${columns[field]} = @${field}`)
          .join(', ');
        const result = db
          .prepare(`UPDATE tokens SET ${assignments} WHERE id = @id`)
          .run(params);
        return result.changes > 0 ? stmts.tokenById.get(id) : null;
      },
      delete: (id) => stmts.deleteToken.run(id).changes > 0,
      move: (id, x, y) => stmts.moveToken.run({ id, x, y }).changes > 0,
    },
  };
}
