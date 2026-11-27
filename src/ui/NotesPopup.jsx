import { useState } from 'react';
import { notesStore, useNotes } from '../store/notesStore.js';
import { IconButton } from './Primitives.jsx';
import ToolIcon from './ToolIcon.jsx';

export default function NotesPopup({ onClose }) {
  const folders = useNotes((s) => s.folders);
  const notes = useNotes((s) => s.notes);
  const loading = useNotes((s) => s.loading);

  const [expandedFolders, setExpandedFolders] = useState({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const [renaming, setRenaming] = useState(null); // { kind: 'folder'|'note', id, value }
  const [confirmDelete, setConfirmDelete] = useState(null); // { kind: 'folder'|'note', id, label, childCount }
  const [dragOverTarget, setDragOverTarget] = useState(null); // 'root' | folderId

  const unfiledNotes = notes.filter((n) => !n.folderId);

  function toggleFolder(folderId) {
    setExpandedFolders((prev) => ({
      ...prev,
      [folderId]: prev[folderId] === undefined ? false : !prev[folderId],
    }));
  }

  function isFolderOpen(folderId) {
    return expandedFolders[folderId] !== false;
  }

  async function handleCreateFolder(e) {
    e.preventDefault();
    const clean = folderDraft.trim();
    if (!clean) return;
    const created = await notesStore.getState().createFolder(clean);
    if (created) {
      setExpandedFolders((prev) => ({ ...prev, [created.id]: true }));
    }
    setFolderDraft('');
    setCreatingFolder(false);
  }

  async function handleRenameSubmit(e) {
    e.preventDefault();
    if (!renaming) return;
    const clean = renaming.value.trim();
    if (!clean) return;
    if (renaming.kind === 'folder') {
      await notesStore.getState().renameFolder(renaming.id, clean);
    } else {
      await notesStore
        .getState()
        .updateNote(renaming.id, { title: clean }, { immediate: true });
    }
    setRenaming(null);
  }

  function handleDragStartNote(e, noteId) {
    e.dataTransfer.setData('application/x-hakton-note', noteId);
    e.dataTransfer.setData('text/plain', noteId);
    e.dataTransfer.effectAllowed = 'move';
  }

  async function handleDropOnTarget(e, folderId) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverTarget(null);
    const noteId =
      e.dataTransfer.getData('application/x-hakton-note') ||
      e.dataTransfer.getData('text/plain');
    if (!noteId) return;
    const note = notes.find((n) => n.id === noteId);
    if (!note || (note.folderId ?? null) === (folderId ?? null)) return;
    if (folderId) {
      setExpandedFolders((prev) => ({ ...prev, [folderId]: true }));
    }
    await notesStore
      .getState()
      .updateNote(noteId, { folderId: folderId ?? null }, { immediate: true });
  }

  function renderNoteRow(note, indented = false) {
    const isRenaming = renaming?.kind === 'note' && renaming.id === note.id;
    return (
      <div
        key={note.id}
        className={`notes-item-row ${indented ? 'indented' : ''}`}
        draggable={!isRenaming}
        onDragStart={(e) => handleDragStartNote(e, note.id)}
      >
        {isRenaming ? (
          <form className="notes-inline-form" onSubmit={handleRenameSubmit}>
            <input
              aria-label="Note title"
              value={renaming.value}
              maxLength={120}
              onChange={(e) =>
                setRenaming((r) => (r ? { ...r, value: e.target.value } : null))
              }
              autoFocus
            />
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" onClick={() => setRenaming(null)}>
              ×
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              className="notes-item-open"
              title={`Open "${note.title}" (drag to move into a folder)`}
              onClick={() => notesStore.getState().openNoteWindow(note.id)}
            >
              <ToolIcon name="notes" />
              <span>{note.title || 'Untitled Note'}</span>
            </button>
            <div className="notes-row-actions">
              <button
                type="button"
                aria-label={`Rename note ${note.title}`}
                title="Rename note"
                onClick={() =>
                  setRenaming({
                    kind: 'note',
                    id: note.id,
                    value: note.title || 'Untitled Note',
                  })
                }
              >
                <ToolIcon name="text" />
              </button>
              <button
                type="button"
                className="danger-hover"
                aria-label={`Delete note ${note.title}`}
                title="Delete note"
                onClick={() =>
                  setConfirmDelete({
                    kind: 'note',
                    id: note.id,
                    label: note.title || 'Untitled Note',
                    childCount: 0,
                  })
                }
              >
                <ToolIcon name="trash" />
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <aside className="floating-popup notes-window" aria-label="Notebook">
      <header>
        <h2>Notebook</h2>
        <div className="notes-header-actions">
          <button
            type="button"
            className="notes-add-btn"
            title="New note"
            onClick={() => void notesStore.getState().createNote()}
          >
            <ToolIcon name="plus" />
            <span>Note</span>
          </button>
          <button
            type="button"
            className="notes-add-btn"
            title="New folder"
            onClick={() => {
              setCreatingFolder((v) => !v);
              setFolderDraft('');
            }}
          >
            <ToolIcon name="folder" />
            <span>Folder</span>
          </button>
          <IconButton label="Close notes" onClick={onClose}>
            ×
          </IconButton>
        </div>
      </header>

      <div className="notes-popup-body">
        {creatingFolder && (
          <form className="notes-inline-form create-folder" onSubmit={handleCreateFolder}>
            <input
              aria-label="Folder name"
              placeholder="Folder name…"
              value={folderDraft}
              maxLength={80}
              onChange={(e) => setFolderDraft(e.target.value)}
              autoFocus
            />
            <button type="submit" className="primary">
              Add
            </button>
            <button type="button" onClick={() => setCreatingFolder(false)}>
              ×
            </button>
          </form>
        )}

        {loading && <p className="notes-empty">Loading private notes…</p>}

        {!loading && folders.length === 0 && notes.length === 0 && (
          <p className="notes-empty">
            Your private journal is empty. Add a note or folder — only you can see them.
          </p>
        )}

        <div className="notes-tree">
          {folders.map((folder) => {
            const folderNotes = notes.filter((n) => n.folderId === folder.id);
            const open = isFolderOpen(folder.id);
            const isRenaming =
              renaming?.kind === 'folder' && renaming.id === folder.id;

            return (
              <div
                key={folder.id}
                className={`notes-folder-group ${
                  dragOverTarget === folder.id ? 'drag-over' : ''
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragOverTarget !== folder.id) setDragOverTarget(folder.id);
                }}
                onDragLeave={() => {
                  if (dragOverTarget === folder.id) setDragOverTarget(null);
                }}
                onDrop={(e) => void handleDropOnTarget(e, folder.id)}
              >
                <div className="notes-folder-row">
                  {isRenaming ? (
                    <form className="notes-inline-form" onSubmit={handleRenameSubmit}>
                      <input
                        aria-label="Folder name"
                        value={renaming.value}
                        maxLength={80}
                        onChange={(e) =>
                          setRenaming((r) =>
                            r ? { ...r, value: e.target.value } : null,
                          )
                        }
                        autoFocus
                      />
                      <button type="submit" className="primary">
                        Save
                      </button>
                      <button type="button" onClick={() => setRenaming(null)}>
                        ×
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="notes-folder-toggle"
                        aria-expanded={open}
                        onClick={() => toggleFolder(folder.id)}
                      >
                        <ToolIcon name={open ? 'folderOpen' : 'folder'} />
                        <span className="notes-folder-name">{folder.name}</span>
                        <small>{folderNotes.length}</small>
                      </button>
                      <div className="notes-row-actions">
                        <button
                          type="button"
                          aria-label={`New note in ${folder.name}`}
                          title={`New note in "${folder.name}"`}
                          onClick={() => {
                            setExpandedFolders((p) => ({ ...p, [folder.id]: true }));
                            void notesStore
                              .getState()
                              .createNote({ folderId: folder.id });
                          }}
                        >
                          <ToolIcon name="plus" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Rename folder ${folder.name}`}
                          title="Rename folder"
                          onClick={() =>
                            setRenaming({
                              kind: 'folder',
                              id: folder.id,
                              value: folder.name,
                            })
                          }
                        >
                          <ToolIcon name="text" />
                        </button>
                        <button
                          type="button"
                          className="danger-hover"
                          aria-label={`Delete folder ${folder.name}`}
                          title="Delete folder"
                          onClick={() =>
                            setConfirmDelete({
                              kind: 'folder',
                              id: folder.id,
                              label: folder.name,
                              childCount: folderNotes.length,
                            })
                          }
                        >
                          <ToolIcon name="trash" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {open && (
                  <div className="notes-folder-children">
                    {folderNotes.length === 0 ? (
                      <div className="notes-folder-drop-hint">
                        Drop a note here
                      </div>
                    ) : (
                      folderNotes.map((note) => renderNoteRow(note, true))
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <div
            className={`notes-root-zone ${dragOverTarget === 'root' ? 'drag-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dragOverTarget !== 'root') setDragOverTarget('root');
            }}
            onDragLeave={() => {
              if (dragOverTarget === 'root') setDragOverTarget(null);
            }}
            onDrop={(e) => void handleDropOnTarget(e, null)}
          >
            {folders.length > 0 && (
              <div className="notes-root-heading">Notes (Unfiled)</div>
            )}
            {unfiledNotes.map((note) => renderNoteRow(note, false))}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <div
          className="notes-confirm-backdrop"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="notes-confirm-dialog"
            role="alertdialog"
            aria-label="Confirm delete"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>
              {confirmDelete.kind === 'folder'
                ? 'Are you sure you want to delete this folder?'
                : 'Are you sure you want to delete this note?'}
            </h3>
            {confirmDelete.kind === 'folder' ? (
              confirmDelete.childCount > 0 ? (
                <p>
                  <strong>“{confirmDelete.label}”</strong> is not empty —{' '}
                  <strong>
                    {confirmDelete.childCount}{' '}
                    {confirmDelete.childCount === 1 ? 'note file' : 'note files'}
                  </strong>{' '}
                  inside this folder will also be permanently deleted.
                </p>
              ) : (
                <p>
                  Remove empty folder <strong>“{confirmDelete.label}”</strong>?
                </p>
              )
            ) : (
              <p>
                Permanently delete <strong>“{confirmDelete.label}”</strong>? This
                action cannot be undone.
              </p>
            )}
            <div className="form-actions">
              <button type="button" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={async () => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  if (target.kind === 'folder') {
                    await notesStore.getState().deleteFolder(target.id);
                  } else {
                    await notesStore.getState().deleteNote(target.id);
                  }
                }}
              >
                Yes, delete
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
