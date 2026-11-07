import { useState } from 'react';
import { Tabs } from './Primitives.jsx';

// Controlled HP stays in the presentation shell; replace with the character adapter later.
export default function CharacterSheet({ person, hp, setHp }) {
  const [sheetTab, setSheetTab] = useState('Abilities');
  return (
    <>
      <p className="character-detail">{person.detail}</p>
      <div className="sheet-summary">
        <label>
          Hit points
          <input
            type="number"
            aria-label="Current hit points"
            min="0"
            max={person.max}
            value={person.name === 'Mira' ? hp : person.hp}
            disabled={person.name !== 'Mira'}
            onChange={(e) =>
              setHp(Math.min(person.max, Math.max(0, Number(e.target.value))))
            }
          />
          <small> / {person.max}</small>
        </label>
        <div>
          <span>Armor class</span>
          <strong>{person.ac}</strong>
        </div>
        <div>
          <span>Speed</span>
          <strong>30 ft</strong>
        </div>
      </div>
      <Tabs
        items={['Abilities', 'Inventory']}
        value={sheetTab}
        onChange={setSheetTab}
        label="Character sheet"
      />
      {sheetTab === 'Abilities' ? (
        <div className="ability-grid">
          {Object.entries({
            STR: 12,
            DEX: 16,
            CON: 14,
            INT: 10,
            WIS: 15,
            CHA: 8,
          }).map(([a, v]) => (
            <div key={a}>
              <span>{a}</span>
              <strong>{v}</strong>
              <small>
                {Math.floor((v - 10) / 2) >= 0 ? '+' : ''}
                {Math.floor((v - 10) / 2)}
              </small>
            </div>
          ))}
        </div>
      ) : (
        <>
          <details open>
            <summary>Backpack</summary>
            <div className="reference-row">
              Rations <span>5 days</span>
            </div>
            <div className="reference-row">
              Rope <span>50 ft</span>
            </div>
          </details>
          <details>
            <summary>Bag of Holding</summary>
            <div className="reference-row">
              Healing potion <span>2</span>
            </div>
          </details>
        </>
      )}
    </>
  );
}
