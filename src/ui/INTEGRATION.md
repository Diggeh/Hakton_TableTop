# Frontend integration

The presentation lives in `src/ui/`; `src/App.jsx` only mounts it. No backend, database, network, storage, Electron, or existing Konva files were changed. No dependencies were added to the package manifest or lockfile.

## Running

Use the existing `npm run dev` for Electron, or `npm run dev:renderer` for a browser preview. Choose Host/Join, select a campaign, then Start/Join campaign. The tabletop source selector switches between the schematic preview and the existing live Konva board. Live connections use the existing Electron preload and `connect()` API, not the selected sample campaign.

## Boundaries

- `fixtures.js`: sample campaigns, party, and asset catalogs. These never enter `sessionStore` or SQLite.
- `HaktonUI.jsx`: start menu, profile, compact campaign list, separate campaign-info dialog, and preview add/remove flows. Replace local campaign state with the campaign/session service when available. Host/Join are navigation previews, not network session operations.
- `Tabletop.jsx`: independent player/chat/asset windows, canvas tool actions, preview role, dice request fields, session notes. The role switch is a design preview, not an authorization system. Actual permissions must come from the host.
- `Board.jsx`: measures available canvas space, lazy-loads the unchanged `MapStage` in live mode, calls unchanged `connect()` only when the Electron bridge exists. Existing token movement and synchronization remain owned by `src/canvas` and `src/net`. Preview zoom/grid affect the schematic only.
- `AssetsPanel.jsx`: category/search/selection UI. Import stays disabled pending the asset ingestion service. Scene changes select a preview label; the sample schematic is shared, not a supplied battle-map image.
- `ChatPanel.jsx`: local message drafts/history, recipient and channel selection. Collapsing preserves messages. Replace local submission/history with the text/whisper adapter. No private message or dice result is sent over the network by this UI.
- `CharacterSheet.jsx`, `Compendium.jsx`: local presentation examples for Charles to bind to character, inventory, and FTS5 services. Sheet HP edits remain local to the tabletop preview.
- `Primitives.jsx`: shared buttons, keyboard-navigable tabs, native focus-trapped dialogs.
- `hakton.css`: shared control styling. `prototype.css`: Scrying Pool colors and prototype geometry, including slate windows over midnight navy, restrained aqua state colors, and a contrasting mineral map surface, separate dice tray, canvas-edge toolbars, and desktop breakpoints. `ToolIcon.jsx` follows the supplied legend. `DiceTray.jsx` contains the independent tray presentation.

Dice preparation deliberately does not generate outcomes or implement Aerown's dice engine. Audio and import/image controls remain disabled until connected. Voice has no interface or integration in this change. Campaigns/profile are in memory for this visit; tabletop preview state resets on leaving the table.

## Verification

Production renderer build passed. Browser checks at 1440x900 and 960x600 covered DM/player navigation; campaign add/remove; dialogs; asset filtering and scene selection; local public/whisper composition; character sheet/inventory; compendium empty state; board source and unavailable Electron state; grid/zoom; collapsed panels. Browser console had no warnings/errors during these checks.

Impeccable source detection reported zero anti-pattern failures and one advisory for the functional tabletop grid. Its rendered-page detector could not launch its browser; visual review used the running browser directly. Native Electron launch was blocked by automatic approval review (`blocked by policy`), so native runtime and end-to-end multiplayer persistence are unverified.

Design references: https://impeccable.style/slop/ and https://github.com/wpgaurav/design-slop. The interface keeps the supplied prototype structure while refining the visual treatment: separate rounded panels; compact extension toolbar at canvas top-left; vertical utilities at top-right; centered asset launcher at the bottom; category bar above the canvas; and a separate asset manager below. The compact player list sits at upper-left, the dice tray below it, and chat at upper-right. DM and Player are separate role views, not two simultaneous canvases. Voice remains excluded even though newer screenshots show its reserved area. No remote fonts, image downloads, decorative gradients, or new UI libraries.

Visual refinement: larger type and controls, differentiated scene thumbnails, and more legible map linework. The preview map and thumbnails remain local schematic fixtures, not imported campaign assets.
