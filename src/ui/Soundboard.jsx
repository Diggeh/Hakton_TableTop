import { useRef, useState } from 'react';
import {
  cueLayer,
  isValidCueIcon,
  SOUND_CUES,
  SOUND_ICON_OPTIONS,
} from '../../shared/soundboard.js';
import ToolIcon from './ToolIcon.jsx';
import './soundboard.css';

function iconForCue(cue) {
  if (cue.id === 'coastal-wind') return 'wind';
  if (cue.id === 'sanctuary') return 'sanctuary';
  if (cue.id === 'hearthfire') return 'lute';
  if (cue.id === 'battle-drums') return 'drum';
  if (cue.id === 'bell') return 'bell';
  if (cue.id === 'thunder') return 'bolt';
  return cue.kind === 'loop' ? 'waveform' : 'bolt';
}

function CueIconGlyph({ cue }) {
  const icon = cue?.icon;
  if (typeof icon === 'string' && icon.startsWith('data:image/')) {
    return <img src={icon} alt="" className="sound-tile-custom-img" />;
  }
  return <ToolIcon name={icon || iconForCue(cue)} />;
}

async function resizeCustomIconImage(file) {
  if (!file) return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read image file.'));
      el.src = objectUrl;
    });
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const srcW = img.naturalWidth || img.width || size;
    const srcH = img.naturalHeight || img.height || size;
    const crop = Math.min(srcW, srcH);
    const sx = Math.max(0, Math.round((srcW - crop) / 2));
    const sy = Math.max(0, Math.round((srcH - crop) / 2));
    ctx.drawImage(img, sx, sy, crop, crop, 0, 0, size, size);
    let dataUrl = canvas.toDataURL('image/webp', 0.85);
    if (!isValidCueIcon(dataUrl)) {
      dataUrl = canvas.toDataURL('image/png');
    }
    return isValidCueIcon(dataUrl) ? dataUrl : null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function LayerBar({ label, layerName, slot, cue, ready, canControl, onCommand }) {
  const isPlaying = Boolean(slot?.playing);
  return (
    <div
      className={`soundboard-layer-bar ${slot ? (isPlaying ? 'playing' : 'paused') : 'idle'}`}
      data-layer={layerName}
    >
      <div className="soundboard-layer-info">
        <span className={`soundboard-eq ${isPlaying ? 'active' : ''}`} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div className="soundboard-layer-text">
          <small>{label}</small>
          <span role="status">
            {cue
              ? `${cue.name}${isPlaying ? '' : ' · Paused'}`
              : 'Idle'}
          </span>
        </div>
      </div>
      {canControl && (
        <div className="soundboard-actions">
          <button
            type="button"
            className="soundboard-icon-btn"
            aria-label={`Loop ${label}`}
            title={`Toggle loop for ${label}`}
            disabled={!ready || !slot}
            aria-pressed={slot?.loop ?? false}
            onClick={() =>
              void onCommand('loop', slot?.cueId, !(slot?.loop ?? false), layerName)
            }
          >
            <ToolIcon name="loop" />
          </button>
          <button
            type="button"
            className="soundboard-icon-btn"
            aria-label={isPlaying ? `Pause ${label}` : `Resume ${label}`}
            title={isPlaying ? `Pause ${label}` : `Resume ${label}`}
            disabled={!ready || !slot}
            onClick={() =>
              void onCommand(isPlaying ? 'pause' : 'resume', slot?.cueId, undefined, layerName)
            }
          >
            <ToolIcon name={isPlaying ? 'pause' : 'play'} />
          </button>
          <button
            type="button"
            className="soundboard-icon-btn danger-hover"
            aria-label={`Stop ${label}`}
            title={`Stop ${label}`}
            disabled={!ready || !slot}
            onClick={() => void onCommand('stop', slot?.cueId, undefined, layerName)}
          >
            <ToolIcon name="stop" />
          </button>
        </div>
      )}
    </div>
  );
}

function MixerSlider({ label, icon, value, onChange, disabled }) {
  const prevRef = useRef(value > 0 ? value : 60);
  if (value > 0) prevRef.current = value;
  return (
    <div className="soundboard-mixer-row">
      <button
        type="button"
        className="soundboard-icon-btn mute-toggle"
        aria-label={value === 0 ? `Unmute ${label}` : `Mute ${label}`}
        title={label}
        disabled={disabled}
        aria-pressed={value === 0}
        onClick={() => onChange(value === 0 ? prevRef.current || 60 : 0)}
      >
        <ToolIcon name={value === 0 ? 'mute' : icon} />
      </button>
      <input
        aria-label={label}
        title={label}
        type="range"
        min="0"
        max="100"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
      <span className="soundboard-mixer-pct" aria-hidden="true">
        {value}%
      </span>
    </div>
  );
}

export default function Soundboard({ controls, canControl, preview }) {
  const { state, cues, ready, enabled, volume, error, command, importing } =
    controls;
  const [search, setSearch] = useState('');
  const [importTarget, setImportTarget] = useState({ kind: 'effect', layer: 'ambience' });
  const [editingIconCueId, setEditingIconCueId] = useState(null);
  const [iconImageError, setIconImageError] = useState('');
  const fileInputRef = useRef(null);
  const iconImageInputRef = useRef(null);

  const library = [...SOUND_CUES, ...cues];
  const query = search.trim().toLowerCase();
  const matches = (cue) => !query || cue.name.toLowerCase().includes(query);

  const musicSlot = state.music ?? null;
  const ambienceSlot = state.ambience ?? (!state.music ? state.track : null);
  const musicCue = musicSlot ? library.find((c) => c.id === musicSlot.cueId) : null;
  const ambienceCue = ambienceSlot
    ? library.find((c) => c.id === ambienceSlot.cueId)
    : null;

  const musicCues = library.filter(
    (c) => c.kind === 'loop' && cueLayer(c) === 'music' && matches(c),
  );
  const ambienceCues = library.filter(
    (c) => c.kind === 'loop' && cueLayer(c) === 'ambience' && matches(c),
  );
  const effectCues = library.filter((c) => c.kind === 'effect' && matches(c));
  const editingCue = editingIconCueId
    ? cues.find((c) => c.id === editingIconCueId) || null
    : null;

  function openImportPicker(kind, layer = 'ambience') {
    if (!ready || !controls.canImport || importing) return;
    setImportTarget({ kind, layer });
    fileInputRef.current?.click();
  }

  function handleLoopTileClick(cue, layerName) {
    const activeSlot = layerName === 'music' ? musicSlot : ambienceSlot;
    if (activeSlot?.cueId === cue.id) {
      void command(
        activeSlot.playing ? 'pause' : 'resume',
        cue.id,
        undefined,
        layerName,
      );
      return;
    }
    void command('play', cue.id, undefined, layerName);
  }

  async function handleCustomIconUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !editingCue) return;
    setIconImageError('');
    try {
      const dataUrl = await resizeCustomIconImage(file);
      if (!dataUrl) {
        setIconImageError('Image is too large or unsupported. Choose PNG, JPEG, WebP, or GIF.');
        return;
      }
      controls.setCueIcon?.(editingCue.id, dataUrl);
      setEditingIconCueId(null);
    } catch (err) {
      setIconImageError(err?.message || 'Could not load image.');
    }
  }

  return (
    <div className="soundboard">
      {/* Pinned Top Region: Active Deck Controls + Search */}
      <div className="soundboard-pinned-top">
        <div className="soundboard-deck">
          <LayerBar
            label="Music"
            layerName="music"
            slot={musicSlot}
            cue={musicCue}
            ready={ready}
            canControl={canControl}
            onCommand={command}
          />
          <LayerBar
            label="Ambience"
            layerName="ambience"
            slot={ambienceSlot}
            cue={ambienceCue}
            ready={ready}
            canControl={canControl}
            onCommand={command}
          />
        </div>

        {canControl && (
          <div className="soundboard-search">
            <ToolIcon name="search" />
            <input
              aria-label="Search sounds"
              placeholder="Find a sound or track…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* Scrollable Center Region: Only Playable Cue Tiles */}
      {canControl && (
        <div className="soundboard-scroll-area">
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp3,.wav,.ogg,.oga,.opus,.flac"
            hidden
            disabled={!ready || !controls.canImport || importing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void controls.importAudio(file, importTarget.kind, importTarget.layer);
              }
              e.target.value = '';
            }}
          />

          {[
            { key: 'music', kind: 'loop', label: 'Music', items: musicCues },
            { key: 'ambience', kind: 'loop', label: 'Ambience', items: ambienceCues },
            { key: 'effect', kind: 'effect', label: 'Sound Effects', items: effectCues },
          ].map((section) => (
            <section
              key={section.key}
              className="soundboard-section"
              aria-label={section.label}
            >
              <h3>{section.label}</h3>
              <div className="soundboard-grid">
                {section.items.map((cue) => {
                  const slot =
                    section.key === 'music'
                      ? musicSlot
                      : section.key === 'ambience'
                        ? ambienceSlot
                        : null;
                  const isActive = slot?.cueId === cue.id;
                  const isPlaying = Boolean(isActive && slot?.playing);
                  const isCustom = cue.id.startsWith('custom-');
                  return (
                    <div
                      key={cue.id}
                      className={`sound-tile ${isActive ? 'active' : ''} ${
                        isPlaying ? 'playing' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="sound-tile-btn"
                        aria-label={
                          isActive
                            ? isPlaying
                              ? `Pause ${cue.name}`
                              : `Resume ${cue.name}`
                            : `Play ${cue.name}`
                        }
                        aria-pressed={section.kind === 'loop' ? isActive : undefined}
                        title={
                          isActive
                            ? isPlaying
                              ? `${cue.name} — Click to pause`
                              : `${cue.name} — Click to resume`
                            : cue.name
                        }
                        disabled={!ready}
                        onClick={() =>
                          section.kind === 'loop'
                            ? handleLoopTileClick(cue, section.key)
                            : void command('trigger', cue.id)
                        }
                      >
                        <span className="sound-tile-icon">
                          <CueIconGlyph cue={cue} />
                        </span>
                        <span className="sound-tile-name">{cue.name}</span>
                      </button>
                      {isCustom && (
                        <>
                          <button
                            type="button"
                            className="sound-tile-icon-edit"
                            aria-label={`Customize icon for ${cue.name}`}
                            title="Customize icon"
                            disabled={!ready}
                            onClick={(e) => {
                              e.stopPropagation();
                              setIconImageError('');
                              setEditingIconCueId((curr) =>
                                curr === cue.id ? null : cue.id,
                              );
                            }}
                          >
                            <ToolIcon name="draw" />
                          </button>
                          <button
                            type="button"
                            className="sound-tile-remove"
                            aria-label={`Remove ${cue.name}`}
                            title={`Remove ${cue.name}`}
                            disabled={!ready || isActive}
                            onClick={() => controls.removeAudio(cue.id)}
                          >
                            <ToolIcon name="trash" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="sound-tile sound-tile-add"
                  aria-label={`Add ${section.label}`}
                  title={`Import audio into ${section.label}`}
                  disabled={!ready || !controls.canImport || importing}
                  onClick={() =>
                    openImportPicker(
                      section.kind,
                      section.key === 'music' ? 'music' : 'ambience',
                    )
                  }
                >
                  <ToolIcon name="plus" />
                  <span>
                    {importing && importTarget.layer === section.key ? 'Adding…' : 'Add'}
                  </span>
                </button>
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Pinned Bottom Region: Dual Volume Sliders & Status */}
      <div className="soundboard-pinned-bottom">
        <div className="soundboard-mixer">
          {!enabled && (
            <button
              type="button"
              className="primary soundboard-enable-btn"
              onClick={() => void controls.enable()}
            >
              <ToolIcon name="headphones" />
              <span>Enable Audio</span>
            </button>
          )}
          {canControl && (
            <MixerSlider
              label="Table volume"
              icon="volume"
              value={state.volume}
              disabled={!ready}
              onChange={(value) => void command('volume', undefined, value)}
            />
          )}
          <MixerSlider
            label="My volume"
            icon="headphones"
            value={volume}
            onChange={controls.changeVolume}
          />
        </div>

        {error ? (
          <p className="notice" role="alert">
            {error}
          </p>
        ) : (
          !ready && (
            <p className="notice" role="status">
              Waiting for session audio…
            </p>
          )
        )}
        {preview && <small>Local preview</small>}
      </div>

      {/* Customize Icon Picker Overlay for Imported Soundboard Buttons */}
      {editingCue && (
        <div
          className="soundboard-icon-picker-backdrop"
          onClick={() => setEditingIconCueId(null)}
        >
          <div
            className="soundboard-icon-picker"
            role="dialog"
            aria-label={`Customize icon for ${editingCue.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <strong>Icon · {editingCue.name}</strong>
              <button
                type="button"
                className="soundboard-icon-btn"
                aria-label="Close icon picker"
                onClick={() => setEditingIconCueId(null)}
              >
                ×
              </button>
            </header>
            <div className="soundboard-icon-picker-grid">
              {SOUND_ICON_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`sound-picker-option ${
                    editingCue.icon === opt.id ? 'active' : ''
                  }`}
                  aria-label={opt.label}
                  title={opt.label}
                  onClick={() => {
                    controls.setCueIcon?.(editingCue.id, opt.id);
                    setEditingIconCueId(null);
                  }}
                >
                  <ToolIcon name={opt.id} />
                </button>
              ))}
            </div>
            <input
              ref={iconImageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => void handleCustomIconUpload(e)}
            />
            {iconImageError && (
              <p className="soundboard-picker-error" role="alert">
                {iconImageError}
              </p>
            )}
            <div className="soundboard-icon-picker-footer">
              <button
                type="button"
                className="sound-picker-action"
                onClick={() => iconImageInputRef.current?.click()}
              >
                Upload image…
              </button>
              {editingCue.icon && (
                <button
                  type="button"
                  className="sound-picker-action"
                  onClick={() => {
                    controls.setCueIcon?.(editingCue.id, null);
                    setEditingIconCueId(null);
                  }}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
