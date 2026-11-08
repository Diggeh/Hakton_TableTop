import { useState } from 'react';
import { Tabs } from './Primitives.jsx';

const FALLBACK_ABILITIES = { str: 12, dex: 16, con: 14, int: 10, wis: 15, cha: 8 };
const ABILITY_LABELS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

/**
 * Character sheet bound to the autosaved store document.
 *
 * `person` remains the presentation fixture (name, portrait, fallback values);
 * `character` is the live SQLite-backed row. When it is absent (preview board)
 * the sheet renders fixture values read-only.
 *
 * @param {{
 *   person: object,
 *   character?: object|null,
 *   canEdit?: boolean,
 *   onHpChange?: (value: number) => void,
 * }} props
 */
export default function CharacterSheet({ person, character = null, canEdit = false, onHpChange }) {
  const [sheetTab, setSheetTab] = useState('Abilities');

  const sheet = character?.sheetData ?? {};
  const hp = sheet.hp ?? { current: person.hp ?? 0, max: person.max ?? 0 };
  const maxHp = Number.isFinite(Number(hp.max)) ? Number(hp.max) : (person.max ?? 0);
  const currentHp = Number.isFinite(Number(hp.current)) ? Number(hp.current) : (person.hp ?? 0);
  const abilities = sheet.abilities ?? FALLBACK_ABILITIES;
  const inventory = Array.isArray(sheet.inventory) ? sheet.inventory : null;
  const editable = Boolean(canEdit && character && typeof onHpChange === 'function');

  return (
    <>
      <p className="character-detail">{sheet.detail ?? person.detail}</p>
      <div className="sheet-summary">
        <label>
          Hit points
          <input
            type="number"
            aria-label="Current hit points"
            min="0"
            max={maxHp}
            value={currentHp}
            disabled={!editable}
            title={editable ? undefined : 'Only the owner or a DM can edit this sheet.'}
            onChange={(e) => {
              const next = Math.min(maxHp, Math.max(0, Number(e.target.value) || 0));
              onHpChange(next);
            }}
          />
          <small> / {maxHp}</small>
        </label>
        <div>
          <span>Armor class</span>
          <strong>{sheet.ac ?? person.ac}</strong>
        </div>
        <div>
          <span>Speed</span>
          <strong>{sheet.speed ?? 30} ft</strong>
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
          {ABILITY_LABELS.map((label) => {
            const value = Number(abilities[label.toLowerCase()] ?? FALLBACK_ABILITIES[label.toLowerCase()]);
            const modifier = Math.floor((value - 10) / 2);
            return (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>
                  {modifier >= 0 ? '+' : ''}
                  {modifier}
                </small>
              </div>
            );
          })}
        </div>
      ) : inventory ? (
        inventory.map((group) => (
          <details key={group.group} open={Boolean(group.open)}>
            <summary>{group.group}</summary>
            {(group.items ?? []).map((item) => (
              <div className="reference-row" key={`${group.group}-${item.name}`}>
                {item.name} <span>{item.qty}</span>
              </div>
            ))}
          </details>
        ))
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
