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
- `ChatPanel.jsx`: retains the local preview and selects `LiveChatPanel.jsx` in live mode. The chat adapter and dedicated Zustand store handle public messages, private whispers, and image attachments.
- `CharacterSheet.jsx`, `Compendium.jsx`: local presentation examples for Charles to bind to character, inventory, and FTS5 services. Sheet HP edits remain local to the tabletop preview.
- `Primitives.jsx`: shared buttons, keyboard-navigable tabs, native focus-trapped dialogs.
- `hakton.css`: shared control styling. `prototype.css`: Scrying Pool colors and prototype geometry, including slate windows over midnight navy, restrained aqua state colors, and a contrasting mineral map surface, separate dice tray, canvas-edge toolbars, and desktop breakpoints. `ToolIcon.jsx` follows the supplied legend. `DiceTray.jsx` contains the independent tray presentation.

Dice preparation deliberately does not generate outcomes or implement Aerown's dice engine. Audio and asset import controls remain disabled until connected. Voice has no interface or integration in this change. Campaigns/profile are in memory for this visit; tabletop preview state resets on leaving the table.

## Verification

Production renderer build passed. Browser checks at 1440x900 and 960x600 covered DM/player navigation; campaign add/remove; dialogs; asset filtering and scene selection; local public/whisper composition; character sheet/inventory; compendium empty state; board source and unavailable Electron state; grid/zoom; collapsed panels. Browser console had no warnings/errors during these checks.

Impeccable source detection reported zero anti-pattern failures and one advisory for the functional tabletop grid. Its rendered-page detector could not launch its browser; visual review used the running browser directly. Native Electron launch was blocked by automatic approval review (`blocked by policy`), so native runtime and end-to-end multiplayer persistence are unverified.

Design references: https://impeccable.style/slop/ and https://github.com/wpgaurav/design-slop. The interface keeps the supplied prototype structure while refining the visual treatment: separate rounded panels; compact extension toolbar at canvas top-left; vertical utilities at top-right; centered asset launcher at the bottom; category bar above the canvas; and a separate asset manager below. The compact player list sits at upper-left, the dice tray below it, and chat at upper-right. DM and Player are separate role views, not two simultaneous canvases. Voice remains excluded even though newer screenshots show its reserved area. No remote fonts, image downloads, decorative gradients, or new UI libraries.

Visual refinement: larger type and controls, differentiated scene thumbnails, and more legible map linework. The preview map and thumbnails remain local schematic fixtures, not imported campaign assets.

## Socket.io branch integration

The `src/App.jsx` merge conflict was resolved by retaining the frontend entry point and moving the networking status presentation into `SessionStatus.jsx`. Live mode displays the authoritative participant roster, connected user, online count, host address, and connection errors. Board connection requests use the selected display name and role; the backend still authorizes the role. Returning to preview or leaving the live table disconnects the client. Sample campaign selection and preview tools remain local; live mode connects to the embedded session, not the sample campaign ID.

Validation after merging: renderer production build and all 16 existing networking tests.

## Delgado Sprint 2 chat

`shared/chatEvents.js` defines the contract. `backend/chat/handlers.js` uses the existing authenticated participant registry and chat repository. `src/net/chat.js` attaches to the existing socket and `src/store/chatStore.js` isolates message state. The host delivers whispers directly to the selected participant and acknowledges them to the sender.

`database/models/chat.js` returns up to 100 visible messages for the authenticated session, filtering private rows before applying the limit. The sender and recipient can recover whispers on reconnect with their original participant IDs. Chat history uses the host session ID and participant IDs.

The renderer accepts PNG, JPEG, or WebP files up to 10 MiB and compresses them to WebP with a 1280-pixel edge limit and a 256 KiB upload limit. The host stores the image in the existing chat payload. History and live events carry only message metadata. The inline viewer fetches the bytes separately after the host verifies access.

The server assigns sender identity and timestamps and saves before broadcasting. Retrying the same request with the restored player identity returns the saved message without another row or broadcast. The renderer merges acknowledgments/live events/history by message ID, shows pending/failed sends and retry, reloads history after reconnect, and clears message state on leaving/changing sessions. No automatic retry sends messages while disconnected.

`npm test` covers networking and chat, including access to whispers and images with multiple clients. `npm run test:chat:storage` checks SQLite persistence and session filtering after reopening the database.

Run `npm run dev`, open a sample campaign, select **Existing live board**, and wait for your live identity to appear. Use **Table → Attach image** for a public attachment. With another participant connected to the same session, select **Whispers**, choose the participant, and send text or attach an image. **Preview board** chat is local-only.
