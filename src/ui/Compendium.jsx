import { useState } from 'react';
export default function Compendium() {
  const [query, setQuery] = useState('');
  const entries = [
    {
      name: 'Difficult terrain',
      type: 'Rule',
      text: 'Each foot of movement costs 1 extra foot in difficult terrain.',
    },
    {
      name: 'Dash',
      type: 'Action',
      text: 'Gain extra movement equal to your speed for the current turn.',
    },
    {
      name: 'Help',
      type: 'Action',
      text: 'Aid an ally with a task or an attack, subject to the action’s conditions.',
    },
  ];
  const results = entries.filter((e) =>
    `${e.name} ${e.type}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <input
        aria-label="Search compendium"
        placeholder="Search sample rules…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.map((e) => (
        <details className="reference-entry" key={e.name}>
          <summary>
            {e.name}
            <small>{e.type}</small>
          </summary>
          <p>{e.text}</p>
        </details>
      ))}
      {!results.length && (
        <p className="empty-inline">No matching sample references.</p>
      )}
    </>
  );
}
