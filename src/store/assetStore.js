import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { sessionStore } from './sessionStore.js';

/**
 * Tab definitions matching the Assets Manager UI specification:
 * SCENES | CHARACTERS | MAPS | PROPS | ATTACHMENTS
 */
export const ASSET_MANAGER_TABS = Object.freeze([
  { id: 'scenes', label: 'SCENES', defaultType: 'map' },
  { id: 'characters', label: 'CHARACTERS', defaultType: 'token' },
  { id: 'maps', label: 'MAPS', defaultType: 'map' },
  { id: 'props', label: 'PROPS', defaultType: 'token' },
  { id: 'attachments', label: 'ATTACHMENTS', defaultType: 'map' },
]);

/**
 * Formats byte count into a human-readable string (e.g. "2.4 MB", "140 KB").
 */
export function formatAssetBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function getBridge() {
  const api = globalThis?.window?.hakton?.assets;
  if (!api) {
    throw new Error('window.hakton.assets preload bridge is not available');
  }
  return api;
}

/**
 * Headless vanilla Zustand store for Map & Token Uploads, Asset Storage, and Asset Catalogs.
 * Designed to be wired directly into any React UI (e.g. AssetsPanel / Assets Manager modal)
 * or called imperatively from canvas/tabletop controllers.
 */
export const assetStore = createStore((set, get) => ({
  assets: [],
  total: 0,
  loading: false,
  uploading: false,
  error: null, // { code, message } | null
  feedback: null, // { kind: 'success' | 'warning' | 'error', message: string, failed?: Array } | null

  // Catalog filter state
  filterType: 'all', // 'all' | 'map' | 'token'
  filterCategory: 'all', // 'all' | 'scenes' | 'characters' | 'maps' | 'props' | 'attachments'
  searchQuery: '',
  campaignId: null,

  // Selection & preview state (stable asset IDs)
  selectedMapAssetId: null,
  selectedTokenAssetId: null,
  previewAssetId: null,

  // Staged native-dialog files (for 2-step select -> upload workflows)
  stagedFiles: [],

  clearFeedback: () => set({ feedback: null, error: null }),

  setFilterType: async (filterType) => {
    set({ filterType: filterType || 'all' });
    return get().loadAssets();
  },

  setFilterCategory: async (filterCategory) => {
    set({ filterCategory: filterCategory || 'all' });
    return get().loadAssets();
  },

  setSearchQuery: async (searchQuery) => {
    set({ searchQuery: String(searchQuery ?? '') });
    return get().loadAssets();
  },

  setCampaignId: async (campaignId) => {
    set({ campaignId: campaignId ?? null });
    return get().loadAssets();
  },

  setPreviewAssetId: (previewAssetId) => set({ previewAssetId: previewAssetId ?? null }),

  /**
   * Loads/refreshes the asset catalog from SQLite using active filters.
   */
  loadAssets: async (overrideFilters = {}) => {
    const state = get();
    const query = {
      type: overrideFilters.type ?? state.filterType,
      category: overrideFilters.category ?? state.filterCategory,
      search: overrideFilters.search ?? state.searchQuery,
      campaignId: overrideFilters.campaignId !== undefined ? overrideFilters.campaignId : state.campaignId,
      limit: overrideFilters.limit ?? 200,
      offset: overrideFilters.offset ?? 0,
    };

    set({ loading: true, error: null });
    try {
      const res = await getBridge().list(query);
      if (!res?.ok) {
        const errObj = res?.error ?? { code: 'E_LIST_FAILED', message: 'Failed to load asset catalog' };
        set({ loading: false, error: errObj });
        return { ok: false, error: errObj, assets: [] };
      }

      set({
        assets: res.assets ?? [],
        total: res.total ?? (res.assets?.length ?? 0),
        loading: false,
        error: null,
      });
      return { ok: true, assets: res.assets ?? [], total: res.total ?? 0 };
    } catch (err) {
      const errObj = { code: 'E_IPC_ERROR', message: err.message };
      set({ loading: false, error: errObj });
      return { ok: false, error: errObj, assets: [] };
    }
  },

  /**
   * Opens the native Electron file picker and immediately uploads the selected map/token image(s).
   * Prevents duplicate submissions while an upload is already in progress.
   */
  pickAndUpload: async ({ type, category, campaignId, metadata, multiSelections = true } = {}) => {
    if (get().uploading) {
      return {
        ok: false,
        canceled: false,
        error: { code: 'E_UPLOAD_IN_PROGRESS', message: 'An upload is already in progress' },
      };
    }

    const activeCategory = category ?? (get().filterCategory !== 'all' ? get().filterCategory : undefined);
    const activeType =
      type ??
      (get().filterType !== 'all'
        ? get().filterType
        : ASSET_MANAGER_TABS.find((t) => t.id === activeCategory)?.defaultType ?? 'map');

    set({ uploading: true, error: null, feedback: null });
    try {
      const res = await getBridge().pickAndUpload({
        type: activeType,
        category: activeCategory,
        campaignId: campaignId ?? get().campaignId,
        metadata,
        multiSelections,
      });

      if (res?.canceled) {
        set({ uploading: false });
        return { ok: true, canceled: true, uploaded: [], failed: [] };
      }

      if (!res?.ok) {
        const errObj = res?.error ?? { code: 'E_UPLOAD_FAILED', message: 'Asset upload failed' };
        set({
          uploading: false,
          error: errObj,
          feedback: { kind: 'error', message: errObj.message, failed: res?.failed ?? [] },
        });
        return { ok: false, canceled: false, uploaded: [], failed: res?.failed ?? [], error: errObj };
      }

      const uploadedCount = res.uploaded?.length ?? 0;
      const failedCount = res.failed?.length ?? 0;
      const feedback =
        failedCount > 0
          ? {
              kind: 'warning',
              message: `Uploaded ${uploadedCount} asset(s); ${failedCount} failed validation.`,
              failed: res.failed,
            }
          : {
              kind: 'success',
              message: `Successfully uploaded ${uploadedCount} asset(s).`,
              failed: [],
            };

      set({ uploading: false, feedback, error: null });
      await get().loadAssets();
      return { ok: true, canceled: false, uploaded: res.uploaded ?? [], failed: res.failed ?? [] };
    } catch (err) {
      const errObj = { code: 'E_IPC_ERROR', message: err.message };
      set({
        uploading: false,
        error: errObj,
        feedback: { kind: 'error', message: errObj.message },
      });
      return { ok: false, canceled: false, uploaded: [], failed: [], error: errObj };
    }
  },

  /**
   * Two-step workflow step 1: opens native Electron file dialog and stages selected files in state.
   */
  selectFiles: async ({ type, multiSelections = true } = {}) => {
    try {
      const res = await getBridge().selectFiles({ type, multiSelections });
      if (!res?.ok) {
        const errObj = res?.error ?? { code: 'E_SELECT_FAILED', message: 'File selection failed' };
        set({ error: errObj });
        return { ok: false, canceled: false, files: [], error: errObj };
      }
      if (!res.canceled) {
        set({ stagedFiles: res.files ?? [] });
      }
      return res;
    } catch (err) {
      const errObj = { code: 'E_IPC_ERROR', message: err.message };
      set({ error: errObj });
      return { ok: false, canceled: false, files: [], error: errObj };
    }
  },

  /**
   * Two-step workflow step 2: uploads files previously selected via `selectFiles`.
   */
  uploadStagedFiles: async ({ type, category, filePaths, campaignId, metadata } = {}) => {
    if (get().uploading) {
      return {
        ok: false,
        error: { code: 'E_UPLOAD_IN_PROGRESS', message: 'An upload is already in progress' },
      };
    }

    const pathsToUpload = filePaths ?? get().stagedFiles.map((f) => f.filePath);
    if (!pathsToUpload?.length) {
      return {
        ok: false,
        error: { code: 'E_NO_FILES', message: 'No staged files to upload' },
      };
    }

    set({ uploading: true, error: null, feedback: null });
    try {
      const res = await getBridge().uploadPaths({
        type: type ?? (get().filterType !== 'all' ? get().filterType : 'map'),
        category: category ?? (get().filterCategory !== 'all' ? get().filterCategory : undefined),
        filePaths: pathsToUpload,
        campaignId: campaignId ?? get().campaignId,
        metadata,
      });

      if (!res?.ok) {
        const errObj = res?.error ?? { code: 'E_UPLOAD_FAILED', message: 'Asset upload failed' };
        set({
          uploading: false,
          error: errObj,
          feedback: { kind: 'error', message: errObj.message, failed: res?.failed ?? [] },
        });
        return { ok: false, uploaded: [], failed: res?.failed ?? [], error: errObj };
      }

      set({
        uploading: false,
        stagedFiles: [],
        feedback: {
          kind: (res.failed?.length ?? 0) > 0 ? 'warning' : 'success',
          message: `Uploaded ${res.uploaded?.length ?? 0} asset(s).`,
          failed: res.failed ?? [],
        },
      });
      await get().loadAssets();
      return { ok: true, uploaded: res.uploaded ?? [], failed: res.failed ?? [] };
    } catch (err) {
      const errObj = { code: 'E_IPC_ERROR', message: err.message };
      set({ uploading: false, error: errObj, feedback: { kind: 'error', message: errObj.message } });
      return { ok: false, uploaded: [], failed: [], error: errObj };
    }
  },

  /**
   * Uploads browser `File` / `Blob` objects or raw byte payloads (e.g. from drag-and-drop or `<input type="file">`).
   */
  uploadFileList: async ({ type, category, files, campaignId, metadata } = {}) => {
    if (get().uploading) {
      return {
        ok: false,
        error: { code: 'E_UPLOAD_IN_PROGRESS', message: 'An upload is already in progress' },
      };
    }

    const list = Array.from(files ?? []);
    if (list.length === 0) {
      return {
        ok: false,
        error: { code: 'E_NO_FILES', message: 'No files selected for upload' },
      };
    }

    set({ uploading: true, error: null, feedback: null });
    try {
      const serialized = await Promise.all(
        list.map(async (file) => {
          if (typeof file?.arrayBuffer === 'function') {
            const ab = await file.arrayBuffer();
            return {
              originalName: file.name,
              displayName: file.displayName,
              data: new Uint8Array(ab),
              type: file.assetType ?? type,
              category: file.category ?? category,
            };
          }
          return file;
        }),
      );

      const res = await getBridge().uploadFiles({
        type: type ?? (get().filterType !== 'all' ? get().filterType : 'map'),
        category: category ?? (get().filterCategory !== 'all' ? get().filterCategory : undefined),
        files: serialized,
        campaignId: campaignId ?? get().campaignId,
        metadata,
      });

      if (!res?.ok) {
        const errObj = res?.error ?? { code: 'E_UPLOAD_FAILED', message: 'Asset upload failed' };
        set({
          uploading: false,
          error: errObj,
          feedback: { kind: 'error', message: errObj.message, failed: res?.failed ?? [] },
        });
        return { ok: false, uploaded: [], failed: res?.failed ?? [], error: errObj };
      }

      set({
        uploading: false,
        feedback: {
          kind: (res.failed?.length ?? 0) > 0 ? 'warning' : 'success',
          message: `Uploaded ${res.uploaded?.length ?? 0} asset(s).`,
          failed: res.failed ?? [],
        },
      });
      await get().loadAssets();
      return { ok: true, uploaded: res.uploaded ?? [], failed: res.failed ?? [] };
    } catch (err) {
      const errObj = { code: 'E_IPC_ERROR', message: err.message };
      set({ uploading: false, error: errObj, feedback: { kind: 'error', message: errObj.message } });
      return { ok: false, uploaded: [], failed: [], error: errObj };
    }
  },

  /**
   * Selects an asset for tabletop use (active battle map or token placement) by stable ID
   * and synchronizes the selection with `sessionStore`.
   */
  selectAsset: (assetOrId) => {
    const state = get();
    const asset =
      typeof assetOrId === 'string'
        ? state.assets.find((a) => a.id === assetOrId) ?? null
        : assetOrId;

    if (!asset) return null;

    if (asset.type === 'token') {
      set({ selectedTokenAssetId: asset.id });
      sessionStore.getState().setSelectedTokenAsset(asset);
    } else {
      set({ selectedMapAssetId: asset.id });
      sessionStore.getState().setSelectedMapAsset(asset);
    }
    return asset;
  },

  /**
   * Renames an asset in the catalog and refreshes local state.
   */
  renameAsset: async (id, name) => {
    try {
      const res = await getBridge().rename(id, name);
      if (!res?.ok) {
        const errObj = res?.error ?? { code: 'E_RENAME_FAILED', message: 'Failed to rename asset' };
        set({ error: errObj });
        return { ok: false, error: errObj };
      }
      set((s) => ({
        assets: s.assets.map((a) => (a.id === id ? res.asset : a)),
        error: null,
      }));
      return { ok: true, asset: res.asset };
    } catch (err) {
      const errObj = { code: 'E_IPC_ERROR', message: err.message };
      set({ error: errObj });
      return { ok: false, error: errObj };
    }
  },

  /**
   * Moves an asset between catalog categories ('scenes'|'characters'|'maps'|'props'|'attachments').
   */
  setAssetCategory: async (id, category) => {
    try {
      const res = await getBridge().setCategory(id, category);
      if (!res?.ok) {
        const errObj = res?.error ?? { code: 'E_CATEGORY_FAILED', message: 'Failed to update category' };
        set({ error: errObj });
        return { ok: false, error: errObj };
      }
      await get().loadAssets();
      return { ok: true, asset: res.asset };
    } catch (err) {
      const errObj = { code: 'E_IPC_ERROR', message: err.message };
      set({ error: errObj });
      return { ok: false, error: errObj };
    }
  },

  /**
   * Deletes an asset from storage and SQLite, clearing any active tabletop selection referencing it.
   */
  deleteAsset: async (id) => {
    try {
      const res = await getBridge().delete(id);
      if (!res?.ok) {
        const errObj = res?.error ?? { code: 'E_DELETE_FAILED', message: 'Failed to delete asset' };
        set({ error: errObj, feedback: { kind: 'error', message: errObj.message } });
        return { ok: false, error: errObj };
      }

      const state = get();
      if (state.selectedMapAssetId === id) {
        set({ selectedMapAssetId: null });
        sessionStore.getState().setSelectedMapAsset(null);
      }
      if (state.selectedTokenAssetId === id) {
        set({ selectedTokenAssetId: null });
        sessionStore.getState().setSelectedTokenAsset(null);
      }
      if (state.previewAssetId === id) {
        set({ previewAssetId: null });
      }

      set({
        feedback: { kind: 'success', message: 'Asset deleted.' },
        error: null,
      });
      await get().loadAssets();
      return { ok: true, deletedId: id };
    } catch (err) {
      const errObj = { code: 'E_IPC_ERROR', message: err.message };
      set({ error: errObj, feedback: { kind: 'error', message: errObj.message } });
      return { ok: false, error: errObj };
    }
  },
}));

/** React binding. Always pass a selector to avoid whole-store re-renders. */
export const useAssets = (selector) => useStore(assetStore, selector);
