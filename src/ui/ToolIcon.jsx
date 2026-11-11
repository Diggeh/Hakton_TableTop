export default function ToolIcon({ name }) {
  const paths = {
    assetMenu: 'M5 3h10l4 4v14H5z M14 3v5h5 M9 14h6 M12 11v6',
    dice: 'M12 2l10 6v9l-10 5-10-5V8z M2 8l10 5 10-5 M12 13v9 M12 2v11',
    home: 'M3 11l9-8 9 8 M5 10v11h5v-7h4v7h5V10',
    players:
      'M9 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M3 21v-5a6 6 0 0 1 12 0v5 M17 4a3 3 0 0 1 0 6 M18 13a5 5 0 0 1 3 5v3',
    initiative: 'M4 20L20 4 M13 4h7v7 M4 13v7h7',
    multi: 'M4 10a6 6 0 1 1 7 6l-5 4v-5a6 6 0 0 1-2-5z',
    chat: 'M3 4h18v13H9l-6 4z M7 10h1 M11 10h1 M15 10h1',
    sheet: 'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6',
    notes: 'M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5',
    compendium: 'M12 5C8 2 3 4 3 4v15s5-2 9 1c4-3 9-1 9-1V4s-5-2-9 1v15',
    soundboard:
      'M9 18V5l10-2v13 M9 5l10-2 M9 18c0 3-6 3-6 0s6-3 6 0 M19 16c0 3-6 3-6 0s6-3 6 0',
    Scenes: 'M3 4h18v16H3z M8 4v16 M3 9h5',
    Characters: 'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M5 21v-5a7 7 0 0 1 14 0v5',
    Maps: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15',
    Props: 'M3 8l9-5 9 5v11H3z M3 8h18 M12 8v11',
    Attachments: 'M8 14l7-7a3 3 0 0 1 4 4L9 21a5 5 0 0 1-7-7L14 2',
    select: 'M5 3l14 10-7 1-3 7z',
    ruler: 'M4 16L16 4l5 5L9 21z M9 11l3 3 M13 7l3 3',
    draw: 'M4 20l1-6L16 3l5 5L10 19z',
    grid: 'M3 3h18v18H3z M9 3v18 M15 3v18 M3 9h18 M3 15h18',
    snap: 'M6 4v8a6 6 0 0 0 12 0V4 M6 9h4 M14 9h4',
    fit: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
    plus: 'M12 5v14 M5 12h14',
    trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 14h10l1-14 M9 7V4h6v3',
    lock: 'M6 11h12v10H6z M9 11V7a3 3 0 0 1 6 0v4',
    unlock: 'M6 11h12v10H6z M9 11V7a3 3 0 0 1 5-2',
    text: 'M5 5h14v3 M12 5v14 M9 19h6',
    fog: 'M3 15h13a3 3 0 1 0 0-6 4 4 0 0 0-7-2 3 3 0 0 0-6 2 M4 19h16',
    wall: 'M3 6h18v12H3z M3 12h18 M9 6v6 M15 6v6 M6 12v6 M12 12v6 M18 12v6',
    door: 'M6 3h12v18H6z M15 12h1',
    dots: 'M12 5v.5 M12 12v.5 M12 19v.5',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.select} />
    </svg>
  );
}
