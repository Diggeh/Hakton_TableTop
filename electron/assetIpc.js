import path from 'node:path';
import {
  InvalidAssetError,
  SUPPORTED_IMAGE_EXTENSIONS,
} from '../storage/index.js';
import {
  normalizeAssetCategory,
  normalizeAssetType,
  toStructuredError,
} from '../backend/assetService.js';

const DIALOG_EXTENSIONS = SUPPORTED_IMAGE_EXTENSIONS.map((ext) => ext.replace(/^\./, ''));

export const ASSET_IPC_CHANNELS = Object.freeze({
  LIST: 'hakton:assets:list',
  GET: 'hakton:assets:get',
  SELECT_FILES: 'hakton:assets:select-files',
  PICK_AND_UPLOAD: 'hakton:assets:pick-and-upload',
  UPLOAD_PATHS: 'hakton:assets:upload-paths',
  UPLOAD_BUFFER: 'hakton:assets:upload-buffer',
  RENAME: 'hakton:assets:rename',
  SET_CATEGORY: 'hakton:assets:set-category',
  UPDATE_METADATA: 'hakton:assets:update-metadata',
  DELETE: 'hakton:assets:delete',
});

/**
 * Registers narrowly scoped Electron IPC handlers for Asset Management.
 * Keeps all filesystem operations inside the privileged main process and enforces an
 * allowlist for dialog-selected file paths.
 *
 * @param {{
 *   ipcMain: { handle(channel: string, listener: Function): void },
 *   dialog: { showOpenDialog(win: any, options: object): Promise<{ canceled: boolean, filePaths: string[] }> },
 *   getMainWindow?: () => any,
 *   assetService: ReturnType<typeof import('../backend/assetService.js').createAssetService>
 * }} deps
 */
export function registerAssetIpcHandlers({ ipcMain, dialog, getMainWindow = () => null, assetService }) {
  if (!ipcMain || !assetService) {
    throw new Error('registerAssetIpcHandlers requires ipcMain and assetService');
  }

  // Only paths explicitly chosen by the user via native dialog may be uploaded by path from the renderer.
  const approvedDialogPaths = new Set();

  function buildDialogOptions({ type, multiSelections = true } = {}) {
    const label = type === 'token' ? 'Select Token Image(s)' : type === 'map' ? 'Select Battle Map(s)' : 'Select Image Asset(s)';
    const properties = ['openFile'];
    if (multiSelections !== false) properties.push('multiSelections');

    return {
      title: label,
      properties,
      filters: [
        {
          name: 'Images (PNG, JPG, WebP, GIF, BMP)',
          extensions: DIALOG_EXTENSIONS,
        },
      ],
    };
  }

  ipcMain.handle(ASSET_IPC_CHANNELS.LIST, (_event, filters = {}) => {
    try {
      const assets = assetService.listAssets(filters ?? {});
      const total = assetService.countAssets(filters ?? {});
      return { ok: true, assets, total };
    } catch (err) {
      return { ok: false, error: toStructuredError(err), assets: [], total: 0 };
    }
  });

  ipcMain.handle(ASSET_IPC_CHANNELS.GET, (_event, payload = {}) => {
    try {
      const id = typeof payload === 'string' ? payload : payload?.id;
      const asset = assetService.getAsset(id);
      if (!asset) {
        return {
          ok: false,
          error: { code: 'E_ASSET_NOT_FOUND', message: `Asset not found: "${id ?? ''}"` },
        };
      }
      return { ok: true, asset };
    } catch (err) {
      return { ok: false, error: toStructuredError(err) };
    }
  });

  ipcMain.handle(ASSET_IPC_CHANNELS.SELECT_FILES, async (_event, opts = {}) => {
    try {
      const win = getMainWindow();
      const dialogOpts = buildDialogOptions(opts ?? {});
      const result = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);

      if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
        return { ok: true, canceled: true, files: [] };
      }

      const files = result.filePaths.map((rawPath) => {
        const resolved = path.resolve(rawPath);
        approvedDialogPaths.add(resolved);
        return {
          filePath: resolved,
          name: path.basename(resolved),
          ext: path.extname(resolved).toLowerCase(),
        };
      });

      return { ok: true, canceled: false, files };
    } catch (err) {
      return { ok: false, error: toStructuredError(err), files: [] };
    }
  });

  ipcMain.handle(ASSET_IPC_CHANNELS.PICK_AND_UPLOAD, async (_event, opts = {}) => {
    try {
      const normalizedType = normalizeAssetType(opts?.type, opts?.category);
      const normalizedCategory = normalizeAssetCategory(opts?.category, normalizedType);

      const win = getMainWindow();
      const dialogOpts = buildDialogOptions({
        type: normalizedType,
        multiSelections: opts?.multiSelections !== false,
      });
      const dialogResult = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);

      if (
        dialogResult.canceled ||
        !Array.isArray(dialogResult.filePaths) ||
        dialogResult.filePaths.length === 0
      ) {
        return { ok: true, canceled: true, uploaded: [], failed: [] };
      }

      const { uploaded, failed } = await assetService.uploadManyFromPaths({
        type: normalizedType,
        category: normalizedCategory,
        filePaths: dialogResult.filePaths,
        campaignId: opts?.campaignId ?? null,
        metadata: opts?.metadata ?? {},
        copy: true,
      });

      if (uploaded.length === 0 && failed.length > 0) {
        return {
          ok: false,
          canceled: false,
          uploaded: [],
          failed,
          error: failed[0].error,
        };
      }

      return {
        ok: true,
        canceled: false,
        uploaded,
        failed,
      };
    } catch (err) {
      return { ok: false, canceled: false, uploaded: [], failed: [], error: toStructuredError(err) };
    }
  });

  ipcMain.handle(ASSET_IPC_CHANNELS.UPLOAD_PATHS, async (_event, payload = {}) => {
    try {
      const rawPaths = Array.isArray(payload?.filePaths)
        ? payload.filePaths
        : typeof payload?.filePath === 'string'
          ? [payload.filePath]
          : [];

      if (rawPaths.length === 0) {
        throw new InvalidAssetError('At least one dialog-selected file path is required');
      }

      const resolvedPaths = [];
      for (const raw of rawPaths) {
        if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
          throw new InvalidAssetError('Invalid file path');
        }
        const resolved = path.resolve(raw);
        if (!approvedDialogPaths.has(resolved)) {
          return {
            ok: false,
            uploaded: [],
            failed: [],
            error: {
              code: 'E_UNAPPROVED_PATH',
              message: 'File path must be selected via the native file picker before uploading',
            },
          };
        }
        resolvedPaths.push(resolved);
      }

      // Consume approved paths on upload attempt
      for (const p of resolvedPaths) approvedDialogPaths.delete(p);

      const { uploaded, failed } = await assetService.uploadManyFromPaths({
        type: payload?.type,
        category: payload?.category,
        filePaths: resolvedPaths,
        campaignId: payload?.campaignId ?? null,
        metadata: payload?.metadata ?? {},
        copy: true,
      });

      if (uploaded.length === 0 && failed.length > 0) {
        return { ok: false, uploaded: [], failed, error: failed[0].error };
      }

      return { ok: true, uploaded, failed };
    } catch (err) {
      return { ok: false, uploaded: [], failed: [], error: toStructuredError(err) };
    }
  });

  ipcMain.handle(ASSET_IPC_CHANNELS.UPLOAD_BUFFER, async (_event, payload = {}) => {
    try {
      if (Array.isArray(payload?.files)) {
        const { uploaded, failed } = await assetService.uploadManyFromBuffers({
          type: payload?.type,
          category: payload?.category,
          files: payload.files,
          campaignId: payload?.campaignId ?? null,
          metadata: payload?.metadata ?? {},
        });

        if (uploaded.length === 0 && failed.length > 0) {
          return { ok: false, uploaded: [], failed, error: failed[0].error };
        }
        return { ok: true, uploaded, failed };
      }

      const asset = await assetService.uploadFromBuffer({
        type: payload?.type,
        category: payload?.category,
        buffer: payload?.data ?? payload?.buffer ?? payload?.bytes,
        originalName: payload?.originalName ?? payload?.name,
        name: payload?.displayName ?? payload?.title,
        campaignId: payload?.campaignId ?? null,
        metadata: payload?.metadata ?? {},
      });

      return { ok: true, asset, uploaded: [asset], failed: [] };
    } catch (err) {
      return { ok: false, uploaded: [], failed: [], error: toStructuredError(err) };
    }
  });

  ipcMain.handle(ASSET_IPC_CHANNELS.RENAME, (_event, { id, name } = {}) => {
    try {
      const asset = assetService.renameAsset(id, name);
      return { ok: true, asset };
    } catch (err) {
      return { ok: false, error: toStructuredError(err) };
    }
  });

  ipcMain.handle(ASSET_IPC_CHANNELS.SET_CATEGORY, (_event, { id, category } = {}) => {
    try {
      const asset = assetService.setAssetCategory(id, category);
      return { ok: true, asset };
    } catch (err) {
      return { ok: false, error: toStructuredError(err) };
    }
  });

  ipcMain.handle(ASSET_IPC_CHANNELS.UPDATE_METADATA, (_event, { id, metadata } = {}) => {
    try {
      const asset = assetService.updateAssetMetadata(id, metadata);
      return { ok: true, asset };
    } catch (err) {
      return { ok: false, error: toStructuredError(err) };
    }
  });

  ipcMain.handle(ASSET_IPC_CHANNELS.DELETE, async (_event, payload = {}) => {
    try {
      const id = typeof payload === 'string' ? payload : payload?.id;
      const result = await assetService.deleteAsset(id);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: toStructuredError(err) };
    }
  });
}
