# Frontend integration

The presentation lives in `src/ui/`; `src/App.jsx` only mounts it. The Socket.io implementation from `implement_socket_io_networking` is merged unchanged; its backend, preload APIs, and Zustand store remain the networking source of truth. The existing Konva file is unchanged. No dependencies were added; package scripts include chat tests.

## Running

Use the existing `npm run dev` for Electron, or `npm run dev:renderer` for a browser preview. Choose Host/Join, select a campaign, then Start/Join campaign. The tabletop source selector switches between the schematic preview and the existing live Konva board. Live connections use the existing Electron preload and `connect()` API, not the selected sample campaign.

## Boundaries

- `fixtures.js`: sample campaigns, party, and asset catalogs. These never enter `sessionStore` or SQLite.
- `HaktonUI.jsx`: start menu, profile, compact campaign list, separate campaign-info dialog, and preview add/remove flows. Replace local campaign state with the campaign/session service when available. Host/Join are navigation previews, not network session operations.
- `Tabletop.jsx`: independent player/chat/asset windows, canvas tool actions, preview role, dice request fields, session notes. The role switch is a design preview, not an authorization system. Actual permissions must come from the host.
- `Board.jsx`: measures available canvas space, lazy-loads the unchanged `MapStage` in live mode, calls unchanged `connect()` only when the Electron bridge exists. Existing token movement and synchronization remain owned by `src/canvas` and `src/net`. Preview zoom/grid affect the schematic only.
- `AssetsPanel.jsx`: category/search/selection UI. Import stays disabled pending the asset ingestion service. Scene changes select a preview label; the sample schematic is shared, not a supplied battle-map image.
- `ChatPanel.jsx`: retains the local preview and selects `LiveChatPanel.jsx` in live mode. Public text and history use the chat adapter and separate Zustand store. Live whispers, image attachments, and rolls remain disabled; the preview controls never send those messages over the network.
- `CharacterSheet.jsx`, `Compendium.jsx`: local presentation examples for Charles to bind to character, inventory, and FTS5 services. Sheet HP edits remain local to the tabletop preview.
- `Primitives.jsx`: shared buttons, keyboard-navigable tabs, native focus-trapped dialogs.
- `hakton.css`: shared control styling. `prototype.css`: Scrying Pool colors and prototype geometry, including slate windows over midnight navy, restrained aqua state colors, and a contrasting mineral map surface, separate dice tray, canvas-edge toolbars, and desktop breakpoints. `ToolIcon.jsx` follows the supplied legend. `DiceTray.jsx` contains the independent tray presentation.

Dice preparation deliberately does not generate outcomes or implement Aerown's dice engine. Audio and import/image controls remain disabled until connected. Voice has no interface or integration in this change. Campaigns/profile are in memory for this visit; tabletop preview state resets on leaving the table.

## Verification

Production renderer build passed. Browser checks at 1440x900 and 960x600 covered DM/player navigation; campaign add/remove; dialogs; asset filtering and scene selection; local public/whisper composition; character sheet/inventory; compendium empty state; board source and unavailable Electron state; grid/zoom; collapsed panels. Browser console had no warnings/errors during these checks.

Impeccable source detection reported zero anti-pattern failures and one advisory for the functional tabletop grid. Its rendered-page detector could not launch its browser; visual review used the running browser directly. Native Electron launch was blocked by automatic approval review (`blocked by policy`), so native runtime and end-to-end multiplayer persistence are unverified.

Design references: https://impeccable.style/slop/ and https://github.com/wpgaurav/design-slop. The interface keeps the supplied prototype structure while refining the visual treatment: separate rounded panels; compact extension toolbar at canvas top-left; vertical utilities at top-right; centered asset launcher at the bottom; category bar above the canvas; and a separate asset manager below. The compact player list sits at upper-left, the dice tray below it, and chat at upper-right. DM and Player are separate role views, not two simultaneous canvases. Voice remains excluded even though newer screenshots show its reserved area. No remote fonts, image downloads, decorative gradients, or new UI libraries.

Visual refinement: larger type and controls, differentiated scene thumbnails, and more legible map linework. The preview map and thumbnails remain local schematic fixtures, not imported campaign assets.

## Socket.io branch integration

The `src/App.jsx` merge conflict was resolved by retaining the frontend entry point and moving the networking status presentation into `SessionStatus.jsx`. Live mode displays the authoritative participant roster, connected user, online count, host address, and connection errors. Board connection requests use the selected display name and role; the backend still authorizes the role. Returning to preview or leaving the live table disconnects the client. Sample campaign selection and preview tools remain local; live mode connects to the embedded session, not the sample campaign ID.

Validation after merging: renderer production build and all 16 existing networking tests.

## Delgado Sprint 2: public text chat

This slice implements public text only. `shared/chatEvents.js` owns its contract; `backend/chat/handlers.js` uses the existing authenticated participant registry and chat repository; `src/net/chat.js` attaches to the existing socket; `src/store/chatStore.js` isolates message state. The only networking hooks register/unregister these handlers. Existing session and token contracts are unchanged.

`database/models/chat.js` gains `get()` and `publicHistoryForSession()` without altering existing methods, migrations, or storage initialization. New text rows carry `sessionId`, `requestId`, and `text` inside the existing JSON payload. History includes at most 100 public text rows for the authenticated session, filtered before limiting. Unscoped legacy rows, whispers, and other message types are excluded. History follows the server session ID, not sample campaign cards; campaign lifecycle/persistent identities remain with their existing owners.

The server assigns sender identity and timestamps and saves before broadcasting. Retrying the same request with the restored player identity returns the saved message without another row or broadcast. The renderer merges acknowledgments/live events/history by message ID, shows pending/failed sends and retry, reloads history after reconnect, and clears message state on leaving/changing sessions. No automatic retry sends messages while disconnected.

Tests: `npm test` covers the existing 16 networking tests plus six chat integration tests using three clients and injected storage. `npm run test:chat:storage` checks real SQLite persistence and session filtering across a database reopen, using Electron's Node runtime to match the installed native SQLite ABI. Browser smoke testing also confirmed send/receive between two clients and history after reload.

Manual test: run `npm run dev`, open a sample campaign, select **Existing live board**, wait for your live identity to appear, then send in **Table**. In **Preview board**, chat remains local-only. Remote host/session selection is still the networking owner's integration boundary; no remote join UI is added in this change.
