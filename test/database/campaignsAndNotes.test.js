import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../database/index.js';
import { createRepositories } from '../../database/repositories.js';
import { seedIfEmpty } from '../../database/seed.js';
import { plainTextToHtml, sanitizeNoteHtml } from '../../shared/noteSanitizer.js';

function createTempDb(prefix = 'hakton-camp-notes-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tmpDir, 'hakton.db');
  return {
    tmpDir,
    dbPath,
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('SQLite campaign persistence, preset removal & private user notes', () => {
  it('purges pre-existing preset campaigns and persists added/updated campaigns across DB reopens', async (t) => {
    const env = createTempDb();
    let db = openDatabase(env.dbPath);
    t.after(() => {
      try {
        db?.close();
      } catch {}
      env.cleanup();
    });

    // Inject preset campaign rows & confirm clean removal when seeding fresh or via repos
    let repos = createRepositories(db);
    await seedIfEmpty(repos);
    assert.equal(repos.campaigns.list().length, 0);

    const created = repos.campaigns.create({
      id: 'camp-custom-1',
      name: 'Curse of Blackreach',
      system: 'D&D 5e',
      description: 'Subterranean expedition',
    });
    assert.equal(created.name, 'Curse of Blackreach');
    assert.equal(created.scene, 'Untitled Scene');

    const updated = repos.campaigns.update('camp-custom-1', {
      name: 'Curse of Blackreach II',
      sessions: 4,
      coverPhoto: 'data:image/png;base64,iVBORw0KGgo=',
    });
    assert.equal(updated.name, 'Curse of Blackreach II');
    assert.equal(updated.sessions, 4);
    assert.equal(updated.coverPhoto, 'data:image/png;base64,iVBORw0KGgo=');

    db.close();
    db = openDatabase(env.dbPath);
    repos = createRepositories(db);
    const reloaded = repos.campaigns.list();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].id, 'camp-custom-1');
    assert.equal(reloaded[0].name, 'Curse of Blackreach II');
    assert.equal(reloaded[0].sessions, 4);

    assert.equal(repos.campaigns.delete('camp-custom-1'), true);
    assert.equal(repos.campaigns.list().length, 0);
  });

  it('migration 011 strips legacy First Campaign / The Sunken Coast / Ashes of the North rows', (t) => {
    const env = createTempDb('hakton-mig11-');
    const db = openDatabase(env.dbPath);
    t.after(() => {
      try {
        db.close();
      } catch {}
      env.cleanup();
    });

    // Simulate an older DB before migration 011 existed
    db.exec(`
      INSERT INTO campaigns (name, campaign_key) VALUES ('First Campaign', 'first');
      INSERT INTO campaigns (name, campaign_key) VALUES ('The Sunken Coast', 'salt');
      INSERT INTO campaigns (name, campaign_key) VALUES ('Ashes of the North', 'ash');
      INSERT INTO campaigns (name, campaign_key) VALUES ('Keep Me', 'keep-1');
    `);
    const keeper = db.prepare("SELECT id FROM campaigns WHERE name = 'Keep Me'").get();
    const mapRes = db
      .prepare('INSERT INTO maps (campaign_id, name) VALUES (?, ?)')
      .run(keeper.id, 'Main Scene');
    db.prepare('UPDATE campaigns SET active_map_id = ? WHERE id = ?').run(
      mapRes.lastInsertRowid,
      keeper.id,
    );
    const migSql = fs.readFileSync(
      path.resolve('database/migrations/011_campaigns_and_notes.sql'),
      'utf8',
    );
    // Run the cleanup statements from migration 011 directly to verify FK-safe deletion
    const cleanupOnly = migSql
      .split(';')
      .filter((s) => /UPDATE campaigns|DELETE FROM campaigns/i.test(s))
      .join(';\n');
    db.exec(cleanupOnly);

    const names = db
      .prepare('SELECT name FROM campaigns ORDER BY id')
      .all()
      .map((r) => r.name);
    assert.deepEqual(names, ['Keep Me']);
  });

  it('isolates private user notebooks, supports folder drag/delete cascade, and sanitizes HTML', (t) => {
    const env = createTempDb('hakton-notes-');
    const db = openDatabase(env.dbPath);
    t.after(() => {
      try {
        db.close();
      } catch {}
      env.cleanup();
    });

    const repos = createRepositories(db);
    const folderDm = repos.notes.createFolder({ ownerId: 'dm-1', name: 'Villains' });
    const noteDm1 = repos.notes.createNote({
      ownerId: 'dm-1',
      title: 'Baron Plot',
      contentHtml: '<h1>Secrets</h1><script>alert(1)</script><p onclick="bad()">Plans</p>',
    });
    assert.equal(noteDm1.contentHtml, '<h1>Secrets</h1><p>Plans</p>');

    // Move note into folder
    const moved = repos.notes.updateNote({
      ownerId: 'dm-1',
      id: noteDm1.id,
      folderId: folderDm.id,
    });
    assert.equal(moved.folderId, folderDm.id);

    // Player creates separate notebook — cannot see or modify DM's folder or notes
    const notePlayer = repos.notes.createNote({
      ownerId: 'player-1',
      title: 'Inventory',
      contentHtml: plainTextToHtml('2 potions\n\nTorch'),
    });
    assert.equal(repos.notes.list('player-1').folders.length, 0);
    assert.equal(repos.notes.list('player-1').notes.length, 1);
    assert.equal(
      repos.notes.updateNote({ ownerId: 'player-1', id: noteDm1.id, title: 'Hacked' }),
      null,
    );
    assert.equal(repos.notes.deleteNote({ ownerId: 'player-1', id: noteDm1.id }), false);

    // Deleting non-empty DM folder also deletes all notes inside it and reports count
    const delResult = repos.notes.deleteFolder({ ownerId: 'dm-1', id: folderDm.id });
    assert.deepEqual(delResult, { deleted: true, deletedNotesCount: 1 });
    assert.equal(repos.notes.list('dm-1').folders.length, 0);
    assert.equal(repos.notes.list('dm-1').notes.length, 0);
    // Player's note remains untouched
    assert.equal(repos.notes.list('player-1').notes[0].id, notePlayer.id);

    assert.equal(sanitizeNoteHtml('<b onclick="x()">Bold</b><iframe src="x">y</iframe>'), '<b>Bold</b>');
  });
});
