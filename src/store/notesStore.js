import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { plainTextToHtml, sanitizeNoteHtml } from '../../shared/noteSanitizer.js';

const LOCAL_KEY_PREFIX = 'hakton:user-notes:v1:';
const SAVE_DEBOUNCE_MS = 300;
const saveTimers = new Map();
let zCounter = 50;

function readLocalNotebook(ownerId) {
  try {
    const raw = localStorage.getItem(`${LOCAL_KEY_PREFIX}${ownerId}`);
    if (!raw) return { folders: [], notes: [] };
    const parsed = JSON.parse(raw);
    return {
      folders: Array.isArray(parsed?.folders) ? parsed.folders : [],
      notes: Array.isArray(parsed?.notes) ? parsed.notes : [],
    };
  } catch {
    return { folders: [], notes: [] };
  }
}

function writeLocalNotebook(ownerId, folders, notes) {
  if (!ownerId) return;
  try {
    localStorage.setItem(
      `${LOCAL_KEY_PREFIX}${ownerId}`,
      JSON.stringify({ folders, notes }),
    );
  } catch {
    // Ignore storage quota errors in restricted environments
  }
}

function hasIpcNotes() {
  return typeof window !== 'undefined' && Boolean(window.hakton?.notes?.list);
}

function initialWindowRect(openCount = 0) {
  const offset = (openCount % 5) * 28;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const width = Math.min(640, Math.max(420, vw - 120));
  const height = Math.min(460, Math.max(300, vh - 160));
  const x = Math.max(24, Math.round((vw - width) / 2) + offset);
  const y = Math.max(58, Math.round((vh - height) / 2) + offset);
  return { x, y, width, height };
}

export const notesStore = createStore((set, get) => ({
  ownerId: null,
  loading: false,
  savingIds: {},
  folders: [],
  notes: [],
  openWindows: [], // [{ noteId, x, y, width, height, minimized, zIndex }]

  async loadForOwner(ownerId, { importLegacyDm = false, legacyRecords = [] } = {}) {
    const cleanOwner = typeof ownerId === 'string' ? ownerId.trim() : '';
    if (!cleanOwner) return;
    const ownerChanged = get().ownerId !== cleanOwner;
    if (ownerChanged) {
      for (const timer of saveTimers.values()) clearTimeout(timer);
      saveTimers.clear();
      set({
        ownerId: cleanOwner,
        loading: true,
        folders: [],
        notes: [],
        openWindows: [],
        savingIds: {},
      });
    } else {
      set({ loading: true });
    }

    if (hasIpcNotes()) {
      const res = await window.hakton.notes.list({
        ownerId: cleanOwner,
        importLegacyDm,
      });
      if (get().ownerId !== cleanOwner) return;
      set({
        loading: false,
        folders: Array.isArray(res?.folders) ? res.folders : [],
        notes: Array.isArray(res?.notes) ? res.notes : [],
      });
      return;
    }

    let { folders, notes } = readLocalNotebook(cleanOwner);
    if (
      importLegacyDm &&
      folders.length === 0 &&
      notes.length === 0 &&
      Array.isArray(legacyRecords)
    ) {
      const migrated = legacyRecords
        .filter(
          (r) =>
            r?.category === 'session-notes' &&
            typeof r?.data?.text === 'string' &&
            r.data.text.trim(),
        )
        .map((r) => ({
          id: `legacy-${r.id}`,
          ownerId: cleanOwner,
          folderId: null,
          title: r.title || 'Session Notes',
          contentHtml: plainTextToHtml(r.data.text),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
      if (migrated.length > 0) {
        notes = migrated;
        writeLocalNotebook(cleanOwner, folders, notes);
      }
    }
    if (get().ownerId !== cleanOwner) return;
    set({ loading: false, folders, notes });
  },

  async createFolder(name = 'New Folder') {
    const ownerId = get().ownerId;
    if (!ownerId) return null;
    const cleanName = String(name || '').trim().slice(0, 80) || 'New Folder';
    if (hasIpcNotes()) {
      const res = await window.hakton.notes.createFolder({ ownerId, name: cleanName });
      if (res?.ok && res.folder) {
        set((s) => ({ folders: [...s.folders, res.folder] }));
        return res.folder;
      }
      return null;
    }
    const now = new Date().toISOString();
    const folder = {
      id: `fld_${crypto.randomUUID()}`,
      ownerId,
      name: cleanName,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => {
      const folders = [...s.folders, folder];
      writeLocalNotebook(ownerId, folders, s.notes);
      return { folders };
    });
    return folder;
  },

  async renameFolder(folderId, name) {
    const ownerId = get().ownerId;
    const cleanName = String(name || '').trim().slice(0, 80);
    if (!ownerId || !folderId || !cleanName) return null;
    set((s) => {
      const folders = s.folders.map((f) =>
        f.id === folderId ? { ...f, name: cleanName, updatedAt: new Date().toISOString() } : f,
      );
      if (!hasIpcNotes()) writeLocalNotebook(ownerId, folders, s.notes);
      return { folders };
    });
    if (hasIpcNotes()) {
      const res = await window.hakton.notes.renameFolder(folderId, cleanName, ownerId);
      if (res?.ok && res.folder) {
        set((s) => ({
          folders: s.folders.map((f) => (f.id === folderId ? res.folder : f)),
        }));
      }
    }
  },

  async deleteFolder(folderId) {
    const ownerId = get().ownerId;
    if (!ownerId || !folderId) return;
    const childIds = new Set(
      get()
        .notes.filter((n) => n.folderId === folderId)
        .map((n) => n.id),
    );
    for (const id of childIds) {
      const timer = saveTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        saveTimers.delete(id);
      }
    }
    set((s) => {
      const folders = s.folders.filter((f) => f.id !== folderId);
      const notes = s.notes.filter((n) => n.folderId !== folderId);
      const openWindows = s.openWindows.filter((w) => !childIds.has(w.noteId));
      if (!hasIpcNotes()) writeLocalNotebook(ownerId, folders, notes);
      return { folders, notes, openWindows };
    });
    if (hasIpcNotes()) {
      await window.hakton.notes.deleteFolder(folderId, ownerId);
    }
  },

  async createNote({ title = 'Untitled Note', folderId = null, contentHtml = '' } = {}) {
    const ownerId = get().ownerId;
    if (!ownerId) return null;
    const cleanTitle = String(title || '').trim().slice(0, 120) || 'Untitled Note';
    const cleanHtml = sanitizeNoteHtml(contentHtml);
    let created = null;
    if (hasIpcNotes()) {
      const res = await window.hakton.notes.createNote({
        ownerId,
        folderId,
        title: cleanTitle,
        contentHtml: cleanHtml,
      });
      if (res?.ok && res.note) created = res.note;
    } else {
      const now = new Date().toISOString();
      created = {
        id: `note_${crypto.randomUUID()}`,
        ownerId,
        folderId: folderId ?? null,
        title: cleanTitle,
        contentHtml: cleanHtml,
        createdAt: now,
        updatedAt: now,
      };
    }
    if (!created) return null;
    set((s) => {
      const notes = [created, ...s.notes];
      if (!hasIpcNotes()) writeLocalNotebook(ownerId, s.folders, notes);
      return { notes };
    });
    get().openNoteWindow(created.id);
    return created;
  },

  async updateNote(noteId, patch = {}, { immediate = false } = {}) {
    const ownerId = get().ownerId;
    if (!ownerId || !noteId) return;
    const sanitizedPatch = { ...patch };
    if (typeof sanitizedPatch.contentHtml === 'string') {
      sanitizedPatch.contentHtml = sanitizeNoteHtml(sanitizedPatch.contentHtml);
    }
    if (typeof sanitizedPatch.title === 'string') {
      sanitizedPatch.title = sanitizedPatch.title.slice(0, 120);
    }

    set((s) => {
      const notes = s.notes.map((n) =>
        n.id === noteId
          ? { ...n, ...sanitizedPatch, updatedAt: new Date().toISOString() }
          : n,
      );
      if (!hasIpcNotes()) writeLocalNotebook(ownerId, s.folders, notes);
      return { notes };
    });

    if (!hasIpcNotes()) return;

    const persist = async () => {
      saveTimers.delete(noteId);
      const latest = get().notes.find((n) => n.id === noteId);
      if (!latest) return;
      set((s) => ({ savingIds: { ...s.savingIds, [noteId]: true } }));
      try {
        await window.hakton.notes.updateNote(noteId, {
          ownerId,
          title: latest.title,
          contentHtml: latest.contentHtml,
          folderId: latest.folderId ?? null,
        });
      } finally {
        set((s) => {
          const next = { ...s.savingIds };
          delete next[noteId];
          return { savingIds: next };
        });
      }
    };

    const prevTimer = saveTimers.get(noteId);
    if (prevTimer) clearTimeout(prevTimer);

    if (immediate) {
      await persist();
    } else {
      const timer = setTimeout(() => {
        void persist();
      }, SAVE_DEBOUNCE_MS);
      saveTimers.set(noteId, timer);
    }
  },

  async flushNoteSave(noteId) {
    if (!noteId || !saveTimers.has(noteId)) return;
    clearTimeout(saveTimers.get(noteId));
    saveTimers.delete(noteId);
    const ownerId = get().ownerId;
    const latest = get().notes.find((n) => n.id === noteId);
    if (!ownerId || !latest || !hasIpcNotes()) return;
    await window.hakton.notes.updateNote(noteId, {
      ownerId,
      title: latest.title,
      contentHtml: latest.contentHtml,
      folderId: latest.folderId ?? null,
    });
  },

  async deleteNote(noteId) {
    const ownerId = get().ownerId;
    if (!ownerId || !noteId) return;
    const timer = saveTimers.get(noteId);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(noteId);
    }
    set((s) => {
      const notes = s.notes.filter((n) => n.id !== noteId);
      const openWindows = s.openWindows.filter((w) => w.noteId !== noteId);
      if (!hasIpcNotes()) writeLocalNotebook(ownerId, s.folders, notes);
      return { notes, openWindows };
    });
    if (hasIpcNotes()) {
      await window.hakton.notes.deleteNote(noteId, ownerId);
    }
  },

  openNoteWindow(noteId) {
    if (!noteId) return;
    set((s) => {
      zCounter += 1;
      const existing = s.openWindows.find((w) => w.noteId === noteId);
      if (existing) {
        return {
          openWindows: s.openWindows.map((w) =>
            w.noteId === noteId ? { ...w, minimized: false, zIndex: zCounter } : w,
          ),
        };
      }
      const rect = initialWindowRect(s.openWindows.length);
      return {
        openWindows: [
          ...s.openWindows,
          { noteId, ...rect, minimized: false, zIndex: zCounter },
        ],
      };
    });
  },

  async closeNoteWindow(noteId) {
    await get().flushNoteSave(noteId);
    set((s) => ({
      openWindows: s.openWindows.filter((w) => w.noteId !== noteId),
    }));
  },

  toggleMinimizeNoteWindow(noteId) {
    set((s) => {
      zCounter += 1;
      return {
        openWindows: s.openWindows.map((w) =>
          w.noteId === noteId
            ? {
                ...w,
                minimized: !w.minimized,
                zIndex: !w.minimized ? w.zIndex : zCounter,
              }
            : w,
        ),
      };
    });
  },

  focusNoteWindow(noteId) {
    set((s) => {
      zCounter += 1;
      return {
        openWindows: s.openWindows.map((w) =>
          w.noteId === noteId ? { ...w, zIndex: zCounter } : w,
        ),
      };
    });
  },

  setNoteWindowBounds(noteId, patch) {
    set((s) => ({
      openWindows: s.openWindows.map((w) =>
        w.noteId === noteId ? { ...w, ...patch } : w,
      ),
    }));
  },
}));

export function useNotes(selector) {
  return useStore(notesStore, selector);
}
