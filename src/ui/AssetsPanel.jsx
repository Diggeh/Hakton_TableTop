import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { assetStore, useAssets } from '../store/assetStore.js';
import { assets as fixtureAssets, party } from './fixtures.js';
import { IconButton, Tabs } from './Primitives.jsx';

const previewImported = {
  Scenes: [],
  Characters: [],
  Maps: [],
  Props: [],
  Attachments: [],
};
const previewListeners = new Set();

function subscribePreviewAssets(listener) {
  previewListeners.add(listener);
  return () => previewListeners.delete(listener);
}

let previewSnapshot = previewImported;

function getPreviewAssetsSnapshot() {
  return previewSnapshot;
}

export function addPreviewUploadedAssets(category, names) {
  if (!names?.length || !previewImported[category]) return;
  const existing = new Set([
    ...(fixtureAssets[category] || []),
    ...previewImported[category],
  ]);
  let changed = false;
  for (const name of names) {
    if (name && !existing.has(name)) {
      previewImported[category].push(name);
      existing.add(name);
      changed = true;
    }
  }
  if (changed) {
    previewSnapshot = { ...previewImported };
    previewListeners.forEach((listener) => listener());
  }
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
  const extra = localPreview[catKey] || [];

  return Array.from(new Set([...base, ...fromStore, ...extra]));
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

  async function handleImportClick() {
    if (typeof window !== 'undefined' && window.hakton?.assets) {
      const res = await assetStore.getState().pickAndUpload({
        category: activeTab.toLowerCase(),
      });
      if (res?.uploaded?.length) {
        setSelected(res.uploaded[0].name);
      }
      return;
    }
    fileInputRef.current?.click();
  }

  function handleFileInputChange(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const names = files.map((f) => f.name.replace(/\.[^.]+$/, '').trim() || f.name);
    addPreviewUploadedAssets(activeTab, names);
    setSelected(names[0]);
    e.target.value = '';
  }

  return (
    <section className="assets-panel" aria-label="Asset manager">
      <header>
        <h2>Assets</h2>
        <Tabs
          items={categories}
          value={activeTab}
          onChange={(t) => {
            setTab(t);
            onCategoryChange?.(t);
            setSelected(null);
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
            onClick={() => void handleImportClick()}
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
            <button
              className={`asset-item ${selected === asset || (activeTab === 'Scenes' && scene === asset) ? 'selected' : ''}`}
              key={asset}
              onClick={() => setSelected(asset)}
              onDoubleClick={() => {
                if (activeTab === 'Scenes') onScene(asset);
                else onInspect(asset, activeTab);
              }}
            >
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
            </button>
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
    </section>
  );
}
