import { randomUUID } from 'node:crypto';
import { plainTextToHtml, sanitizeNoteHtml } from '../../shared/noteSanitizer.js';

function cleanOwner(ownerId) {
  const clean = typeof ownerId === 'string' ? ownerId.trim() : '';
  if (!clean) throw new TypeError('notes ownerId is required');
  return clean;
}

function hydrateFolder(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    folderId: row.folder_id ?? null,
    title: row.title,
    contentHtml: row.content_html ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Private per-user folders & rich-text notes. Every read and mutation scopes
 * queries to `owner_id = @ownerId` so users never access another user's notebook.
 */
export function createNotesModel(db) {
  const stmts = {
    listFolders: db.prepare(
      'SELECT * FROM user_note_folders WHERE owner_id = ? ORDER BY created_at ASC, name COLLATE NOCASE ASC',
    ),
    listNotes: db.prepare(
      'SELECT * FROM user_notes WHERE owner_id = ? ORDER BY updated_at DESC, created_at DESC',
    ),
    folderByIdForOwner: db.prepare(
      'SELECT * FROM user_note_folders WHERE id = ? AND owner_id = ?',
    ),
    noteByIdForOwner: db.prepare(
      'SELECT * FROM user_notes WHERE id = ? AND owner_id = ?',
    ),
    insertFolder: db.prepare(`
      INSERT INTO user_note_folders (id, owner_id, name, created_at, updated_at)
      VALUES (@id, @ownerId, @name, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    renameFolder: db.prepare(`
      UPDATE user_note_folders
      SET name = @name, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @id AND owner_id = @ownerId`),
    countNotesInFolder: db.prepare(
      'SELECT COUNT(*) AS count FROM user_notes WHERE folder_id = ? AND owner_id = ?',
    ),
    deleteNotesInFolder: db.prepare(
      'DELETE FROM user_notes WHERE folder_id = ? AND owner_id = ?',
    ),
    deleteFolder: db.prepare(
      'DELETE FROM user_note_folders WHERE id = ? AND owner_id = ?',
    ),
    insertNote: db.prepare(`
      INSERT INTO user_notes (id, owner_id, folder_id, title, content_html, created_at, updated_at)
      VALUES (@id, @ownerId, @folderId, @title, @contentHtml, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    insertNoteIgnore: db.prepare(`
      INSERT OR IGNORE INTO user_notes (id, owner_id, folder_id, title, content_html, created_at, updated_at)
      VALUES (@id, @ownerId, @folderId, @title, @contentHtml, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    deleteNote: db.prepare(
      'DELETE FROM user_notes WHERE id = ? AND owner_id = ?',
    ),
  };

  function validateFolder(ownerId, folderId) {
    if (!folderId) return null;
    const folder = stmts.folderByIdForOwner.get(folderId, ownerId);
    return folder ? folder.id : null;
  }

  return {
    list(ownerId) {
      const owner = cleanOwner(ownerId);
      return {
        folders: stmts.listFolders.all(owner).map(hydrateFolder),
        notes: stmts.listNotes.all(owner).map(hydrateNote),
      };
    },

    createFolder({ id, ownerId, name = 'New Folder' } = {}) {
      const owner = cleanOwner(ownerId);
      const folderId =
        typeof id === 'string' && id.trim() ? id.trim().slice(0, 80) : `fld_${randomUUID()}`;
      const cleanName =
        typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : 'New Folder';
      stmts.insertFolder.run({ id: folderId, ownerId: owner, name: cleanName });
      return hydrateFolder(stmts.folderByIdForOwner.get(folderId, owner));
    },

    renameFolder({ ownerId, id, name } = {}) {
      const owner = cleanOwner(ownerId);
      const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
      if (!id || !cleanName) return null;
      const res = stmts.renameFolder.run({ id, ownerId: owner, name: cleanName });
      return res.changes > 0 ? hydrateFolder(stmts.folderByIdForOwner.get(id, owner)) : null;
    },

    deleteFolder: db.transaction(({ ownerId, id } = {}) => {
      const owner = cleanOwner(ownerId);
      if (!id) return { deleted: false, deletedNotesCount: 0 };
      const existing = stmts.folderByIdForOwner.get(id, owner);
      if (!existing) return { deleted: false, deletedNotesCount: 0 };
      const countRow = stmts.countNotesInFolder.get(id, owner);
      const deletedNotesCount = Number(countRow?.count ?? 0);
      stmts.deleteNotesInFolder.run(id, owner);
      const deleted = stmts.deleteFolder.run(id, owner).changes > 0;
      return { deleted, deletedNotesCount };
    }),

    createNote({ id, ownerId, folderId = null, title = 'Untitled Note', contentHtml = '' } = {}) {
      const owner = cleanOwner(ownerId);
      const noteId =
        typeof id === 'string' && id.trim() ? id.trim().slice(0, 80) : `note_${randomUUID()}`;
      const cleanTitle =
        typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Untitled Note';
      const validFolderId = validateFolder(owner, folderId);
      const cleanHtml = sanitizeNoteHtml(contentHtml);
      stmts.insertNote.run({
        id: noteId,
        ownerId: owner,
        folderId: validFolderId,
        title: cleanTitle,
        contentHtml: cleanHtml,
      });
      return hydrateNote(stmts.noteByIdForOwner.get(noteId, owner));
    },

    updateNote({ ownerId, id, title, contentHtml, folderId } = {}) {
      const owner = cleanOwner(ownerId);
      if (!id) return null;
      const existing = stmts.noteByIdForOwner.get(id, owner);
      if (!existing) return null;

      const assignments = ["updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"];
      const params = { id, ownerId: owner };

      if (typeof title === 'string') {
        const cleanTitle = title.trim().slice(0, 120) || 'Untitled Note';
        assignments.push('title = @title');
        params.title = cleanTitle;
      }
      if (typeof contentHtml === 'string') {
        assignments.push('content_html = @contentHtml');
        params.contentHtml = sanitizeNoteHtml(contentHtml);
      }
      if (folderId !== undefined) {
        assignments.push('folder_id = @folderId');
        params.folderId = folderId === null ? null : validateFolder(owner, folderId);
      }

      db.prepare(
        `UPDATE user_notes SET ${assignments.join(', ')} WHERE id = @id AND owner_id = @ownerId`,
      ).run(params);
      return hydrateNote(stmts.noteByIdForOwner.get(id, owner));
    },

    deleteNote({ ownerId, id } = {}) {
      const owner = cleanOwner(ownerId);
      if (!id) return false;
      return stmts.deleteNote.run(id, owner).changes > 0;
    },

    importLegacyDmNotes(ownerId, dmRecords = []) {
      const owner = cleanOwner(ownerId);
      if (!Array.isArray(dmRecords) || dmRecords.length === 0) return 0;
      const existingNotes = stmts.listNotes.all(owner);
      const existingFolders = stmts.listFolders.all(owner);
      if (existingNotes.length > 0 || existingFolders.length > 0) return 0;

      let imported = 0;
      for (const record of dmRecords) {
        if (record?.category !== 'session-notes') continue;
        const text = record?.data?.text;
        if (typeof text !== 'string' || !text.trim()) continue;
        const legacyId = `legacy-${record.id}-${owner}`.slice(0, 80);
        const title =
          typeof record.title === 'string' && record.title.trim()
            ? record.title.trim().slice(0, 120)
            : 'Session Notes';
        const res = stmts.insertNoteIgnore.run({
          id: legacyId,
          ownerId: owner,
          folderId: null,
          title,
          contentHtml: plainTextToHtml(text),
        });
        if (res.changes > 0) imported += 1;
      }
      return imported;
    },
  };
}
