import { useState } from 'react';
import { DEFAULT_GRID_SIZE } from '../../shared/events.js';
import { Modal } from './Primitives.jsx';
import { snapPoint } from '../canvas/viewport.js';

/**
 * DM-only token creation. Owners are optional: unassigned tokens are freely
 * movable by players, owned tokens are locked to that participant.
 */
export default function AddTokenDialog({
  map,
  participants = [],
  onCreate,
  onClose,
}) {
  const [label, setLabel] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [color, setColor] = useState('#adfcf9');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const activeParticipants = participants.filter((p) => p.connected);

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;

    const name = label.trim();
    if (!name) {
      setError('Give the token a name.');
      return;
    }

    const grid = map?.gridSize || DEFAULT_GRID_SIZE;
    const centre = snapPoint(
      { x: (map?.width || 1920) / 2, y: (map?.height || 1080) / 2 },
      grid,
    );
    const chosenOwner = ownerId
      ? activeParticipants.find((p) => p.id === ownerId) || null
      : null;

    setBusy(true);
    setError('');
    const response = await onCreate({
      label: name,
      ownerId: ownerId || null,
      ownerRole: chosenOwner?.role ?? null,
      color,
      x: centre.x,
      y: centre.y,
    });
    setBusy(false);

    if (response?.ok) onClose();
    else setError(response?.error || response?.reason || 'Could not create token.');
  }

  return (
    <Modal title="Add token" onClose={onClose}>
      <form className="token-form" onSubmit={handleSubmit}>
        <label>
          Name
          <input
            autoFocus
            maxLength={40}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Goblin raider"
          />
        </label>

        <label>
          Owner
          <select
            value={ownerId}
            onChange={(event) => setOwnerId(event.target.value)}
          >
            <option value="">Unassigned (DM HP only)</option>
            {activeParticipants.map((participant) => (
              <option key={participant.id} value={participant.id}>
                {participant.displayName}
                {participant.role === 'dm' ? ' (DM)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label>
          Colour
          <input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </label>

        {error && <p className="notice">{error}</p>}

        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add token'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
