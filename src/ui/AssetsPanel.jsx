import { useEffect, useState } from 'react';
import { assets, party } from './fixtures.js';
import { IconButton, Tabs } from './Primitives.jsx';
export default function AssetsPanel({
  role,
  category,
  onCategoryChange,
  scene,
  onScene,
  onInspect,
  onClose,
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
  const categories =
    role === 'DM' ? Object.keys(assets) : ['Characters', 'Attachments'];
  const activeTab = categories.includes(tab) ? tab : 'Characters';
  const results = assets[activeTab].filter((a) =>
    a.toLowerCase().includes(search.toLowerCase()),
  );
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
        <IconButton label="Close assets" onClick={onClose}>
          ×
        </IconButton>
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
          <button disabled title="File import unavailable">
            Import files
          </button>
        </div>
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
                className={`asset-thumbnail type-${activeTab.toLowerCase()} thumbnail-${i}`}
              >
                {activeTab === 'Characters' ? (
                  party[i]?.initials
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
