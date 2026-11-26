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
    mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4 M8 23h8',
    micOff:
      'M9 5a3 3 0 0 1 6 0v4 M9 9v3a3 3 0 0 0 5.12 2.12 M19 10v2a7 7 0 0 1-1.63 4.49 M5 10v2a7 7 0 0 0 10.63 5.99 M12 19v4 M8 23h8 M3 3l18 18',
    headphones:
      'M3 18v-6a9 9 0 0 1 18 0v6 M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z',
    headphonesOff:
      'M3 18v-6a9 9 0 0 1 16.5-5 M21 12v6 M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3 M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z M3 3l18 18',
    camera:
      'M23 7l-7 5 7 5V7z M3 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    cameraOff:
      'M23 7l-7 5 7 5V7z M10.66 5H14a2 2 0 0 1 2 2v3.34 M16 16a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2 M3 3l18 18',
    phone:
      'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
    phoneOff:
      'M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67 M14.12 9.88a2 2 0 0 1-.45-2.11 12.84 12.84 0 0 0-.7-2.81A2 2 0 0 0 11 3H8a2 2 0 0 0-2 2c0 1.48.2 2.95.58 4.35 M3 3l18 18',
    wifi: 'M5 12.55a11 11 0 0 1 14.08 0 M1.42 9a16 16 0 0 1 21.16 0 M8.53 16.11a6 6 0 0 1 6.95 0 M12 20h.01',
    refresh:
      'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
    chevronDown: 'M6 9l6 6 6-6',
    chevronUp: 'M18 15l-6-6-6 6',
    check: 'M20 6L9 17l-5-5',
    popout: 'M14 3h7v7 M10 14L21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
    popin: 'M21 3l-9 9 M12 7v5h5 M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
    pin: 'M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6l1-2H8l1 2v4.76z',
    layoutRow: 'M3 7h18v10H3z M9 7v10 M15 7v10',
    layoutColumn: 'M7 3h10v18H7z M7 9h10 M7 15h10',
    layoutGrid: 'M3 3h8v8H3z M13 3h8v8h-8z M3 13h8v8H3z M13 13h8v8h-8z',
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
