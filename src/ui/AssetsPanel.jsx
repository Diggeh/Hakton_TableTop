import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { assetStore, useAssets } from '../store/assetStore.js';
import { assets as fixtureAssets, party } from './fixtures.js';
import ToolIcon from './ToolIcon.jsx';
import { IconButton, Tabs } from './Primitives.jsx';

const previewState = {
  imported: {
    Scenes: [],
    Characters: [],
    Maps: [],
    Props: [],
    Attachments: [],
  },
  renamed: {}, // oldName -> newName
  deleted: new Set(), // deleted asset names
};

const previewListeners = new Set();

function subscribePreviewAssets(listener) {
  previewListeners.add(listener);
  return () => previewListeners.delete(listener);
}

let previewSnapshot = {
  imported: { ...previewState.imported },
  renamed: { ...previewState.renamed },
  deleted: new Set(previewState.deleted),
};

function notifyPreviewListeners() {
  previewSnapshot = {
    imported: {
      Scenes: [...previewState.imported.Scenes],
      Characters: [...previewState.imported.Characters],
      Maps: [...previewState.imported.Maps],
      Props: [...previewState.imported.Props],
      Attachments: [...previewState.imported.Attachments],
    },
    renamed: { ...previewState.renamed },
    deleted: new Set(previewState.deleted),
  };
  previewListeners.forEach((listener) => listener());
}

function getPreviewAssetsSnapshot() {
  return previewSnapshot;
}

export function addPreviewUploadedAssets(category, names) {
  if (!names?.length || !previewState.imported[category]) return;
  const existing = new Set([
    ...(fixtureAssets[category] || []),
    ...previewState.imported[category],
  ]);
  let changed = false;
  for (const name of names) {
    if (name && !existing.has(name)) {
      previewState.imported[category].push(name);
      previewState.deleted.delete(name);
      existing.add(name);
      changed = true;
    }
  }
  if (changed) notifyPreviewListeners();
}

export function renameCatalogAsset(category, oldName, newName) {
  const clean = String(newName || '').trim();
  if (!oldName || !clean || oldName === clean) return;

  // Rename in Electron assetStore if matching DB asset exists
  const storeAssets = assetStore.getState().assets;
  const match = storeAssets.find(
    (a) =>
      a.name === oldName &&
      (!category || (a.category || '').toLowerCase() === category.toLowerCase()),
  );
  if (match && typeof window !== 'undefined' && window.hakton?.assets) {
    void assetStore.getState().renameAsset(match.id, clean);
  }

  if (previewState.imported[category]) {
    previewState.imported[category] = previewState.imported[category].map((n) =>
      n === oldName ? clean : n,
    );
  }
  previewState.renamed[oldName] = clean;
  notifyPreviewListeners();
}

export function deleteCatalogAsset(category, assetName) {
  if (!assetName) return;

  const storeAssets = assetStore.getState().assets;
  const match = storeAssets.find(
    (a) =>
      a.name === assetName &&
      (!category || (a.category || '').toLowerCase() === category.toLowerCase()),
  );
  if (match && typeof window !== 'undefined' && window.hakton?.assets) {
    void assetStore.getState().deleteAsset(match.id);
  }

  if (previewState.imported[category]) {
    previewState.imported[category] = previewState.imported[category].filter(
      (n) => n !== assetName,
    );
  }
  previewState.deleted.add(assetName);
  notifyPreviewListeners();
}

export function useUploadedCategoryAssets(category) {
  const storeAssets = useAssets((s) => s.assets);
  const localPreview = useSyncExternalStore(
    subscribePreviewAssets,
    getPreviewAssetsSnapshot,
  );

  useEffect(() => {
    if (typeof window !== 'undefined' && window.hakton?.assets) {
      void assetStore.getState().loadAssets();
    }
  }, []);

  const catKey = category || 'Scenes';
  const lowerCategory = catKey.toLowerCase();
  const fromStore = storeAssets
    .filter((a) => (a.category || '').toLowerCase() === lowerCategory)
    .map((a) => a.name);
  const base = fixtureAssets[catKey] || [];
  const extra = localPreview.imported[catKey] || [];

  const merged = Array.from(new Set([...base, ...fromStore, ...extra]))
    .map((name) => localPreview.renamed[name] || name)
    .filter((name) => !localPreview.deleted.has(name));

  return Array.from(new Set(merged));
}

export default function AssetsPanel({
  role,
  category,
  onCategoryChange,
  scene,
  onScene,
  onInspect,
  onClose,
  inModal = false,
}) {
  const [tab, setTab] = useState(category || 'Scenes');
  useEffect(() => {
    if (category) {
      setTab(category);
      setSelected(null);
    }
  }, [category]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [openMenuFor, setOpenMenuFor] = useState(null);
  const [renamingAsset, setRenamingAsset] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingAsset, setDeletingAsset] = useState(null);

  // Pre-import Map / Scene Alignment & Crop state
  const [pendingMapAlign, setPendingMapAlign] = useState(null);
  const alignDragRef = useRef(null);

  const fileInputRef = useRef(null);

  const categories =
    role === 'DM' ? Object.keys(fixtureAssets) : ['Characters', 'Attachments'];
  const activeTab = categories.includes(tab) ? tab : 'Characters';
  const categoryItems = useUploadedCategoryAssets(activeTab);
  const uploading = useAssets((s) => s.uploading);
  const feedback = useAssets((s) => s.feedback);

  const results = categoryItems.filter((a) =>
    a.toLowerCase().includes(search.toLowerCase()),
  );

  const isMapOrSceneTab = activeTab === 'Scenes' || activeTab === 'Maps';

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function handleFileInputChange(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const names = files.map(
      (f) => f.name.replace(/\.[^.]+$/, '').trim() || f.name,
    );
    const firstFile = files[0];
    e.target.value = '';

    // For Maps & Scenes, open the interactive Grid Alignment & Resize modal before finalizing import
    if (isMapOrSceneTab) {
      const previewUrl =
        typeof URL !== 'undefined' && URL.createObjectURL
          ? URL.createObjectURL(firstFile)
          : null;
      setPendingMapAlign({
        files,
        names,
        category: activeTab,
        previewUrl,
        scale: 100,
        offsetX: 0,
        offsetY: 0,
        gridSize: 48,
      });
      return;
    }

    finalizeImport(activeTab, files, names, null);
  }

  async function finalizeImport(targetCategory, files, names, alignment) {
    if (
      typeof window !== 'undefined' &&
      window.hakton?.assets &&
      files?.length
    ) {
      await assetStore.getState().uploadFiles({
        type:
          targetCategory === 'Scenes' || targetCategory === 'Maps'
            ? 'map'
            : 'token',
        category: targetCategory.toLowerCase(),
        files,
        metadata: alignment || undefined,
      });
    }
    addPreviewUploadedAssets(targetCategory, names);
    if (names[0]) setSelected(names[0]);
  }

  function handleConfirmMapAlign() {
    if (!pendingMapAlign) return;
    const { category: cat, files, names, scale, offsetX, offsetY, gridSize, previewUrl } =
      pendingMapAlign;
    if (previewUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
      URL.revokeObjectURL(previewUrl);
    }
    setPendingMapAlign(null);
    void finalizeImport(cat, files, names, {
      scale,
      offsetX,
      offsetY,
      gridSize,
    });
  }

  function handleCancelMapAlign() {
    if (
      pendingMapAlign?.previewUrl &&
      typeof URL !== 'undefined' &&
      URL.revokeObjectURL
    ) {
      URL.revokeObjectURL(pendingMapAlign.previewUrl);
    }
    setPendingMapAlign(null);
  }

  function handleRenameConfirm(e) {
    e.preventDefault();
    if (!renamingAsset) return;
    const clean = renameValue.trim();
    if (clean) {
      renameCatalogAsset(activeTab, renamingAsset, clean);
      if (selected === renamingAsset) setSelected(clean);
      if (activeTab === 'Scenes' && scene === renamingAsset) {
        onScene?.(clean);
      }
    }
    setRenamingAsset(null);
    setRenameValue('');
  }

  function handleDeleteConfirm() {
    if (!deletingAsset) return;
    deleteCatalogAsset(activeTab, deletingAsset);
    if (selected === deletingAsset) setSelected(null);
    setDeletingAsset(null);
  }

  return (
    <section
      className="assets-panel"
      aria-label="Asset manager"
      onClick={() => setOpenMenuFor(null)}
    >
      <header>
        <h2>Assets</h2>
        <Tabs
          items={categories}
          value={activeTab}
          onChange={(t) => {
            setTab(t);
            onCategoryChange?.(t);
            setSelected(null);
            setOpenMenuFor(null);
          }}
          label="Asset categories"
        />
        {!inModal && onClose && (
          <IconButton label="Close assets" onClick={onClose}>
            ×
          </IconButton>
        )}
      </header>
      <div className="asset-content">
        <div className="asset-search">
          <input
            aria-label="Search assets"
            placeholder="Search assets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span>
            {results.length} {activeTab.toLowerCase()}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={handleFileInputChange}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={handleImportClick}
          >
            {uploading ? 'Importing…' : 'Import files'}
          </button>
        </div>
        {feedback?.message && (
          <p className="notice" role="status">
            {feedback.message}
          </p>
        )}
        <div className="asset-items">
          {results.map((asset, i) => (
            <div
              className={`asset-item ${selected === asset || (activeTab === 'Scenes' && scene === asset) ? 'selected' : ''}`}
              key={asset}
              role="button"
              tabIndex={0}
              draggable={role === 'DM'}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'application/x-hakton-asset',
                  JSON.stringify({ name: asset, category: activeTab }),
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => setSelected(asset)}
              onDoubleClick={() => {
                if (activeTab === 'Scenes') onScene(asset);
                else onInspect(asset, activeTab);
              }}
            >
              <button
                type="button"
                className="asset-item-dots"
                aria-label={`Options for ${asset}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuFor((curr) => (curr === asset ? null : asset));
                }}
              >
                ⋮
              </button>
              {openMenuFor === asset && (
                <div
                  className="asset-item-menu"
                  role="menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenuFor(null);
                      setRenamingAsset(asset);
                      setRenameValue(asset);
                    }}
                  >
                    <ToolIcon name="text" />
                    <span>Rename</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="danger-item"
                    onClick={() => {
                      setOpenMenuFor(null);
                      setDeletingAsset(asset);
                    }}
                  >
                    <ToolIcon name="trash" />
                    <span>Delete</span>
                  </button>
                </div>
              )}
              <span
                className={`asset-thumbnail type-${activeTab.toLowerCase()} thumbnail-${i % 3}`}
              >
                {activeTab === 'Characters' ? (
                  party[i]?.initials || asset.slice(0, 2).toUpperCase()
                ) : activeTab === 'Attachments' ? (
                  '≡'
                ) : (
                  <span className="mini-plan">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </span>
              <strong>{asset}</strong>
              {activeTab === 'Scenes' && scene === asset && (
                <small>Active</small>
              )}
            </div>
          ))}
          {results.length === 0 && (
            <p className="empty-inline">No matching assets.</p>
          )}
        </div>
        <div className="asset-bottom">
          <span>{selected || ''}</span>
          <button
            disabled={!selected}
            onClick={() =>
              activeTab === 'Scenes'
                ? onScene(selected)
                : onInspect(selected, activeTab)
            }
          >
            {activeTab === 'Scenes' ? 'Open scene' : 'Inspect'}
          </button>
        </div>
      </div>

      {/* Rename Asset Sub-Dialog */}
      {renamingAsset && (
        <div
          className="asset-submodal-backdrop"
          onClick={() => setRenamingAsset(null)}
        >
          <form
            className="asset-submodal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleRenameConfirm}
          >
            <h3>Rename Asset</h3>
            <label>
              Asset name
              <input
                value={renameValue}
                maxLength={60}
                onChange={(e) => setRenameValue(e.target.value)}
                autoFocus
                required
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                onClick={() => setRenamingAsset(null)}
              >
                Cancel
              </button>
              <button type="submit" className="primary">
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Asset Confirmation Sub-Dialog */}
      {deletingAsset && (
        <div
          className="asset-submodal-backdrop"
          onClick={() => setDeletingAsset(null)}
        >
          <div
            className="asset-submodal"
            role="alertdialog"
            aria-label="Confirm delete asset"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Delete Asset?</h3>
            <p>
              Are you sure you want to permanently delete{' '}
              <strong>“{deletingAsset}”</strong>? This action cannot be undone.
            </p>
            <div className="form-actions">
              <button
                type="button"
                onClick={() => setDeletingAsset(null)}
              >
                No, keep it
              </button>
              <button
                type="button"
                className="danger"
                onClick={handleDeleteConfirm}
              >
                Yes, delete forever
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-Import Map / Scene Grid Alignment & Crop Modal */}
      {pendingMapAlign && (
        <div
          className="asset-submodal-backdrop"
          onClick={handleCancelMapAlign}
        >
          <div
            className="asset-submodal map-align-modal"
            role="dialog"
            aria-label="Resize and align map with grid"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Resize & Align Map with Grid</h3>
            <p className="map-align-hint">
              Drag the map preview to align walls with the grid, or adjust scale
              and grid size before importing{' '}
              <strong>{pendingMapAlign.names[0]}</strong>.
            </p>
            <div
              className="map-align-viewport"
              onMouseDown={(e) => {
                alignDragRef.current = {
                  startX: e.clientX - pendingMapAlign.offsetX,
                  startY: e.clientY - pendingMapAlign.offsetY,
                };
              }}
              onMouseMove={(e) => {
                if (!alignDragRef.current) return;
                const nextX = e.clientX - alignDragRef.current.startX;
                const nextY = e.clientY - alignDragRef.current.startY;
                setPendingMapAlign((prev) =>
                  prev ? { ...prev, offsetX: nextX, offsetY: nextY } : null,
                );
              }}
              onMouseUp={() => {
                alignDragRef.current = null;
              }}
              onMouseLeave={() => {
                alignDragRef.current = null;
              }}
            >
              {pendingMapAlign.previewUrl ? (
                <img
                  src={pendingMapAlign.previewUrl}
                  alt="Map alignment preview"
                  draggable={false}
                  style={{
                    transform: `translate(${pendingMapAlign.offsetX}px, ${pendingMapAlign.offsetY}px) scale(${pendingMapAlign.scale / 100})`,
                  }}
                />
              ) : (
                <div
                  className="map-align-placeholder"
                  style={{
                    transform: `translate(${pendingMapAlign.offsetX}px, ${pendingMapAlign.offsetY}px) scale(${pendingMapAlign.scale / 100})`,
                  }}
                >
                  <span>{pendingMapAlign.names[0]}</span>
                </div>
              )}
              <div
                className="map-align-grid-overlay"
                style={{
                  backgroundSize: `${pendingMapAlign.gridSize}px ${pendingMapAlign.gridSize}px`,
                }}
              />
            </div>
            <div className="map-align-controls">
              <label>
                <span>Map Scale ({pendingMapAlign.scale}%)</span>
                <input
                  type="range"
                  min={50}
                  max={200}
                  value={pendingMapAlign.scale}
                  onChange={(e) =>
                    setPendingMapAlign((prev) =>
                      prev ? { ...prev, scale: Number(e.target.value) } : null,
                    )
                  }
                />
              </label>
              <label>
                <span>Grid Size ({pendingMapAlign.gridSize}px)</span>
                <input
                  type="range"
                  min={24}
                  max={96}
                  value={pendingMapAlign.gridSize}
                  onChange={(e) =>
                    setPendingMapAlign((prev) =>
                      prev
                        ? { ...prev, gridSize: Number(e.target.value) }
                        : null,
                    )
                  }
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  setPendingMapAlign((prev) =>
                    prev
                      ? { ...prev, scale: 100, offsetX: 0, offsetY: 0, gridSize: 48 }
                      : null,
                  )
                }
              >
                Reset Alignment
              </button>
            </div>
            <div className="form-actions">
              <button type="button" onClick={handleCancelMapAlign}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleConfirmMapAlign}
              >
                Confirm & Import
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
