export default function ToolIcon({ name }) {
  const paths = {
    assetMenu: 'M5 3h10l4 4v14H5z M14 3v5h5 M9 14h6 M12 11v6',
    dice: 'M12 2l10 6v9l-10 5-10-5V8z M2 8l10 5 10-5 M12 13v9 M12 2v11',
    home: 'M3 11l9-8 9 8 M5 10v11h5v-7h4v7h5V10',
    players:
      'M9 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M3 21v-5a6 6 0 0 1 12 0v5 M17 4a3 3 0 0 1 0 6 M18 13a5 5 0 0 1 3 5v3',
    initiative: 'M4 20L20 4 M13 4h7v7 M4 13v7h7',
    sword: 'M14.5 17.5L3 6V3h3l11.5 11.5 M13 19l6-6 M16 16l4 4 M19 21l2-2',
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
    light: 'M9 18h6 M10 21h4 M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z',
    torch: 'M12 2c1 2 3 3 3 5a3 3 0 0 1-6 0c0-2 2-3 3-5z M9 10l2 12h2l2-12',
    cone: 'M12 3L4 21h16L12 3z',
    brush: 'M18 2l4 4-10 10H8v-4L18 2z M3 21c2-3 4-3 5-3s2 1 2 3H3z',
    polygon: 'M12 3l8 6-3 11H7L4 9z',
    rect: 'M4 5h16v14H4z',
    circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    eraser: 'M19 14l-7 7-9-9 7-7 9 9z M14 4l6 6',
    preview:
      'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    close: 'M18 6L6 18 M6 6l12 12',
    play: 'M6 4l14 8-14 8z',
    pause: 'M6 4h4v16H6z M14 4h4v16h-4z',
    stop: 'M5 5h14v14H5z',
    loop: 'M17 2l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 22l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3',
    volume: 'M11 5L6 9H2v6h4l5 4z M15.5 8.5a5 5 0 0 1 0 7 M18.5 6a9 9 0 0 1 0 12',
    mute: 'M11 5L6 9H2v6h4l5 4z M22 9l-6 6 M16 9l6 6',
    headphones: 'M3 18v-6a9 9 0 0 1 18 0v6 M3 15a2 2 0 0 1 2-2h2v7H5a2 2 0 0 1-2-2z M21 15a2 2 0 0 0-2-2h-2v7h2a2 2 0 0 0 2-2z',
    wind: 'M3 8h11a3 3 0 1 0-3-3 M3 12h15a2.5 2.5 0 1 1-2.5 2.5 M3 16h8a2.5 2.5 0 1 1-2.5 2.5',
    sanctuary: 'M4 20h16 M6 20V11a6 6 0 0 1 12 0v9 M12 3v3 M10 15h4',
    drum: 'M4 9c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5-3.6-3.5-8-3.5S4 7 4 9z M4 9v7c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5V9 M9 12.2v6.8 M15 12.2v6.8',
    lute: 'M12 18a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M15.5 9.5L20 5 M18 3l3 3 M10 13l4-4',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M10.3 21a1.9 1.9 0 0 0 3.4 0',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    waveform: 'M4 12v2 M8 7v10 M12 4v16 M16 8v8 M20 11v2',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.35-4.35',
    sparkles: 'M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z M19 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
    rain: 'M4 13a4 4 0 0 1 1-7.8A5 5 0 0 1 15 4a4.5 4.5 0 0 1 4 6.5A3.5 3.5 0 0 1 18 14 M8 17l-1.5 3 M12 17l-1.5 3 M16 17l-1.5 3',
    waves: 'M2 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0 M2 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0',
    forest: 'M12 3l-5 7h3l-4 6h12l-4-6h3z M12 16v5',
    skull: 'M12 3a7 7 0 0 0-7 7c0 2.5 1.3 4.5 3 5.7V19h8v-3.3c1.7-1.2 3-3.2 3-5.7a7 7 0 0 0-7-7z M9 11.5h.1 M15 11.5h.1 M10 19v-2 M14 19v-2',
    horn: 'M4 14c4 0 9-3 14-8v12c-5-5-10-8-14-8z M4 14v4h3v-4 M20 8v8',
    coins: 'M9 7a5 2.5 0 1 0 10 0 5 2.5 0 0 0-10 0z M9 7v5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7 M4 13a5 2.5 0 1 0 10 0 M4 13v5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-5',
    heart: 'M12 20s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z',
    folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    folderOpen: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H7l-4 8z M7 10h14l-2 9H3z',
    minimize: 'M5 12h14',
  };
  if (name === 'lock') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="17"
        height="17"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        <rect
          x="5"
          y="11"
          width="14"
          height="10"
          rx="2"
          fill="currentColor"
          stroke="currentColor"
        />
        <circle cx="12" cy="15.2" r="1.2" fill="#0d171f" stroke="none" />
        <path d="M12 16.2v2.1" stroke="#0d171f" strokeWidth="1.5" />
      </svg>
    );
  }
  if (name === 'unlock') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="17"
        height="17"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 11V6.5a4 4 0 0 1 7.6-1.6" />
        <rect x="5" y="11" width="14" height="10" rx="2" fill="none" />
      </svg>
    );
  }
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
