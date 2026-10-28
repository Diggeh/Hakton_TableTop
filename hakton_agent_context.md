# Context: Hakton Virtual Tabletop (VTT)

**Role:** Senior Full-Stack Desktop Application Architect
**Project:** Hakton - A private, self-hosted, native desktop virtual tabletop (VTT) and real-time communication application tailored for Dungeons & Dragons 5e/5.5e. 
**Design Theme:** "Scrying Pool" (Deep Navy `#091540`, Cerulean `#3A7CA5`, Icy Aqua `#ADFCF9`, White `#FFFFFF`). Flat, minimalist UI.

## 1. Core Architecture & Tech Stack
Hakton utilizes a decentralized, zero-cloud-dependency architecture. The Dungeon Master (DM) acts as the host server locally.
*   **Desktop Shell:** Electron (packages React frontend and Node.js backend).
*   **Frontend Engine:** React.js.
*   **Canvas Engine:** Konva.js (`react-konva`) for HTML5 2D canvas rendering. Strict layer isolation required (background, grid, interactive tokens).
*   **State Management:** Zustand (Strictly isolated state outside the React component tree. *Do not use React Context for high-frequency updates*).
*   **Backend Engine:** Node.js embedded within the host Electron app.
*   **Real-Time Bus:** Socket.io for state synchronization (tokens, chat, dice). 
*   **Voice/Video:** PeerJS for WebRTC P2P voice communication (Direct client-to-client mesh, no server routing).
*   **Database:** Local file-based SQLite using `better-sqlite3`.

## 2. Hard Constraints & Development Rules
1.  **Modular Decoupling:** The codebase must be strictly decoupled into independent modules for frontend rendering, backend event routing, and SQLite storage/DAL.
2.  **Zero Cloud Dependency:** No external DBs or cloud storage. Everything runs on the DM's local machine.
3.  **Lossless Assets:** Battle maps and token images must be saved directly to the host's hard drive without lossy image re-compression (250MB limit).
4.  **Database Performance:** SQLite MUST run synchronously on Node's V8 thread with `PRAGMA journal_mode = WAL;` enabled to prevent read/write blocking.
5.  **Flexible Document Schema:** Utilize SQLite `JSON` document columns validated with `CHECK(json_valid(...))` for character sheets, inventories, and roll tables to avoid rigid SQL migrations for homebrew content.
6.  **Sub-millisecond Search:** Use the SQLite `FTS5` extension for compendium lookups.

## 3. Database Schema Reference
The embedded SQLite database uses the following schemas (Migration 002):

```sql
-- Character Sheets & Container Inventories
CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    class_level TEXT NOT NULL,
    sheet_data JSON NOT NULL,        -- Core stats, saving throws, HP, spell slots
    inventory_data JSON NOT NULL,    -- Equipped items, Bag of Holding, coin counts
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- DM Workspace (Notes, Roll Tables, Encounters)
CREATE TABLE IF NOT EXISTS dm_records (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,          -- 'campaign_note', 'session_note', 'loot_table', 'curse_table'
    title TEXT NOT NULL,
    data JSON NOT NULL,              -- Freeform text, encounter stats, or dice roll weights
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Chat History & Whisper Logs
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    recipient_id TEXT,               -- NULL for public chat; target userId for private whispers
    type TEXT NOT NULL,              -- 'text', 'whisper', 'dice_roll', 'compressed_image'
    payload JSON NOT NULL,           -- Message body, dice breakdowns, or compressed image file paths
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Compendium Reference (PHB, MM, DMG)
CREATE TABLE IF NOT EXISTS compendium_entries (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,            -- 'PHB', 'MM', 'DMG'
    category TEXT NOT NULL,          -- 'spell', 'monster', 'item', 'rule'
    name TEXT NOT NULL,
    data JSON NOT NULL
);

-- FTS5 Search Index
CREATE VIRTUAL TABLE IF NOT EXISTS compendium_fts USING fts5(
    name, category, source,
    content='compendium_entries', content_rowid='rowid'
);
```

## 4. JSON Data Structures

**Character Sheet & Inventory (`sheet_data` & `inventory_data`)**
```json
{
  "attributes": { "str": 16, "dex": 12, "con": 14, "int": 10, "wis": 8, "cha": 13 },
  "hp": { "current": 28, "max": 32, "temp": 0 },
  "spellSlots": { "1": { "total": 4, "expended": 1 } },
  "containers": [
    {
      "name": "Bag of Holding",
      "maxWeight": 500,
      "items": [
        { "id": "itm_02", "name": "Rations", "weight": 20 }
      ]
    }
  ]
}
```

## 5. Current Project Status & Immediate Focus
*   **Timeline:** Week 6 of 13.
*   **Current Phase:** Phase 1 & 2 (Core Architecture & Board Mechanics).
*   **Immediate Backlog Items:** 
    1. Complete Local File Storage pipeline (resolving OS paths via `app.getPath('userData')` to create the `/uploads` directory for lossless assets).
    2. Establish the Socket.io host server and initial "Welcome Packet" sync broadcast.
    3. Build the base React + Konva canvas layers.

*Agent Instruction: When generating code for this project, always adhere strictly to the decoupled architecture defined above. Output production-ready, highly technical code without generic filler.*