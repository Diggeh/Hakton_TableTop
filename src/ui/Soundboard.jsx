import { useState } from 'react';
import { SOUND_CUES } from '../../shared/soundboard.js';
import './soundboard.css';

function Volume({ label, value, onChange, disabled }) {
  return (
    <label className="soundboard-volume">
      <span>
        {label} <span aria-hidden="true">{value}%</span>
      </span>
      <input
        aria-label={label}
        type="range"
        min="0"
        max="100"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
    </label>
  );
}

export default function Soundboard({ controls, canControl, preview }) {
  const { state, cues, ready, enabled, volume, error, command, importing } =
    controls;
  const [kind, setKind] = useState('effect');
  const library = [...SOUND_CUES, ...cues];
  const current = library.find((cue) => cue.id === state.track?.cueId);
  return (
    <div className="soundboard">
      <div className="soundboard-now">
        <span role="status">
          {current
            ? current.name + (state.track.playing ? '' : ' · Paused')
            : 'No track playing'}
        </span>
        {canControl && (
          <div className="soundboard-actions">
            <button
              disabled={!ready || !current}
              aria-pressed={state.track?.loop ?? false}
              onClick={() => void command('loop', undefined, !state.track.loop)}
            >
              Loop
            </button>
            <button
              disabled={!ready || !current}
              onClick={() =>
                void command(state.track.playing ? 'pause' : 'resume')
              }
            >
              {current && !state.track.playing ? 'Resume' : 'Pause'}
            </button>
            <button
              disabled={!ready || !current}
              onClick={() => void command('stop')}
            >
              Stop track
            </button>
          </div>
        )}
      </div>
      {canControl && (
        <>
          {[
            ['loop', 'Background tracks'],
            ['effect', 'Sound effects'],
          ].map(([category, label]) => (
            <section key={category} aria-label={label}>
              <h3>{label}</h3>
              {library
                .filter((cue) => cue.kind === category)
                .map((cue) => (
                  <div className="reference-row" key={cue.id}>
                    <span>{cue.name}</span>
                    <div className="soundboard-actions">
                      <button
                        aria-label={`Play ${cue.name}`}
                        disabled={!ready || current?.id === cue.id}
                        onClick={() =>
                          void command(
                            category === 'loop' ? 'play' : 'trigger',
                            cue.id,
                          )
                        }
                      >
                        {current?.id === cue.id ? 'Selected' : 'Play'}
                      </button>
                      {cue.id.startsWith('custom-') && (
                        <button
                          aria-label={`Remove ${cue.name}`}
                          disabled={!ready || current?.id === cue.id}
                          onClick={() => controls.removeAudio(cue.id)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </section>
          ))}
          <div className="soundboard-import">
            <label>
              Import as
              <select
                value={kind}
                disabled={importing}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="effect">Sound effect</option>
                <option value="loop">Background track</option>
              </select>
            </label>
            <label>
              {importing ? 'Importing…' : 'Audio file'}
              <input
                type="file"
                accept=".mp3,.wav,.ogg,.oga,.opus,.flac"
                disabled={!ready || !controls.canImport || importing}
                onChange={(e) => {
                  void controls.importAudio(e.target.files[0], kind);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <Volume
            label="Table volume"
            value={state.volume}
            disabled={!ready}
            onChange={(value) => void command('volume', undefined, value)}
          />
        </>
      )}
      <div className="soundboard-listener">
        {!enabled && (
          <button className="primary" onClick={() => void controls.enable()}>
            Enable audio
          </button>
        )}
        <Volume
          label="My volume"
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
  );
}
