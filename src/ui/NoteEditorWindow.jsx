import { useEffect, useRef, useState } from 'react';
import { plainTextToHtml, sanitizeNoteHtml } from '../../shared/noteSanitizer.js';
import { notesStore, useNotes } from '../store/notesStore.js';
import ToolIcon from './ToolIcon.jsx';

const BLOCK_STYLES = [
  { tag: 'p', label: 'Normal text' },
  { tag: 'h1', label: 'Heading 1' },
  { tag: 'h2', label: 'Heading 2' },
  { tag: 'h3', label: 'Heading 3' },
];

function detectCurrentBlockTag(editorEl) {
  if (typeof window === 'undefined' || !editorEl) return 'p';
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 'p';
  let node = sel.anchorNode;
  while (node && node !== editorEl) {
    if (node.nodeType === 1) {
      const tag = node.nodeName.toLowerCase();
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'p') {
        return tag;
      }
    }
    node = node.parentNode;
  }
  return 'p';
}

function detectFormats(editorEl) {
  const formats = {
    block: detectCurrentBlockTag(editorEl),
    bold: false,
    italic: false,
    underline: false,
    ul: false,
    ol: false,
    code: false,
  };
  if (typeof document === 'undefined' || !editorEl) return formats;
  try {
    formats.bold = Boolean(document.queryCommandState('bold'));
    formats.italic = Boolean(document.queryCommandState('italic'));
    formats.underline = Boolean(document.queryCommandState('underline'));
    formats.ul = Boolean(document.queryCommandState('insertUnorderedList'));
    formats.ol = Boolean(document.queryCommandState('insertOrderedList'));
  } catch {
    // Ignore unsupported queryCommandState errors
  }
  const sel = window.getSelection();
  let node = sel?.anchorNode || null;
  while (node && node !== editorEl) {
    if (node.nodeType === 1 && (node.nodeName === 'CODE' || node.nodeName === 'PRE')) {
      formats.code = true;
      break;
    }
    node = node.parentNode;
  }
  return formats;
}

export function NoteEditorWindow({ windowState }) {
  const note = useNotes((s) => s.notes.find((n) => n.id === windowState.noteId));
  const isSaving = useNotes((s) => Boolean(s.savingIds[windowState.noteId]));

  const editorRef = useRef(null);
  const lastNoteIdRef = useRef(null);
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);
  const [formats, setFormats] = useState({
    block: 'p',
    bold: false,
    italic: false,
    underline: false,
    ul: false,
    ol: false,
    code: false,
  });

  // Sync note HTML into contentEditable when opening or switching notes without stomping typing
  useEffect(() => {
    const el = editorRef.current;
    if (!el || !note) return;
    if (lastNoteIdRef.current !== note.id) {
      lastNoteIdRef.current = note.id;
      el.innerHTML = sanitizeNoteHtml(note.contentHtml || '');
    } else if (document.activeElement !== el) {
      const sanitized = sanitizeNoteHtml(note.contentHtml || '');
      if (el.innerHTML !== sanitized) el.innerHTML = sanitized;
    }
  }, [note?.id, note?.contentHtml]);

  useEffect(() => {
    const onSelectionChange = () => {
      const el = editorRef.current;
      if (!el || !el.contains(document.activeElement) && document.activeElement !== el) {
        return;
      }
      setFormats(detectFormats(el));
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  if (!note || windowState.minimized) return null;

  function syncContentToStore({ immediate = false } = {}) {
    const el = editorRef.current;
    if (!el) return;
    const html = sanitizeNoteHtml(el.innerHTML);
    void notesStore
      .getState()
      .updateNote(note.id, { contentHtml: html }, { immediate });
    setFormats(detectFormats(el));
  }

  function applyCommand(cmd, value = null) {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    try {
      document.execCommand(cmd, false, value);
    } catch {
      // Ignore unsupported execCommand calls
    }
    syncContentToStore();
  }

  function applyBlockStyle(tag) {
    setBlockMenuOpen(false);
    applyCommand('formatBlock', tag === 'p' ? 'p' : tag);
  }

  function applyInlineCode() {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    const code = document.createElement('code');
    code.textContent = range.toString();
    range.deleteContents();
    range.insertNode(code);
    range.setStartAfter(code);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    syncContentToStore();
  }

  function startDragWindow(e) {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    e.preventDefault();
    notesStore.getState().focusNoteWindow(note.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = windowState.x;
    const originY = windowState.y;

    const onMove = (ev) => {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const nextX = Math.max(
        8,
        Math.min(vw - 160, originX + (ev.clientX - startX)),
      );
      const nextY = Math.max(
        48,
        Math.min(vh - 80, originY + (ev.clientY - startY)),
      );
      notesStore
        .getState()
        .setNoteWindowBounds(note.id, { x: nextX, y: nextY });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function startResizeWindow(e, mode) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    notesStore.getState().focusNoteWindow(note.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const originW = windowState.width;
    const originH = windowState.height;

    const onMove = (ev) => {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const maxW = Math.max(400, vw - windowState.x - 12);
      const maxH = Math.max(280, vh - windowState.y - 12);
      const patch = {};
      if (mode.includes('e')) {
        patch.width = Math.max(400, Math.min(maxW, originW + (ev.clientX - startX)));
      }
      if (mode.includes('s')) {
        patch.height = Math.max(280, Math.min(maxH, originH + (ev.clientY - startY)));
      }
      notesStore.getState().setNoteWindowBounds(note.id, patch);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const activeBlockMeta =
    BLOCK_STYLES.find((b) => b.tag === formats.block) || BLOCK_STYLES[0];

  return (
    <section
      className="note-editor-window"
      role="dialog"
      aria-label={note.title || 'Untitled Note'}
      style={{
        left: `${windowState.x}px`,
        top: `${windowState.y}px`,
        width: `${windowState.width}px`,
        height: `${windowState.height}px`,
        zIndex: windowState.zIndex,
      }}
      onPointerDown={() => notesStore.getState().focusNoteWindow(note.id)}
      onClick={() => {
        if (blockMenuOpen) setBlockMenuOpen(false);
      }}
    >
      <header className="note-editor-header" onPointerDown={startDragWindow}>
        <div className="note-editor-title-wrap">
          <ToolIcon name="notes" />
          <input
            aria-label="Note title"
            className="note-editor-title-input"
            value={note.title}
            maxLength={120}
            placeholder="Untitled Note"
            onChange={(e) =>
              void notesStore
                .getState()
                .updateNote(note.id, { title: e.target.value })
            }
          />
          <span className="note-save-badge">
            {isSaving ? 'Saving…' : 'Private · Saved'}
          </span>
        </div>
        <div className="note-window-controls">
          <button
            type="button"
            className="note-win-btn"
            aria-label={`Minimize ${note.title}`}
            title="Minimize"
            onClick={() => notesStore.getState().toggleMinimizeNoteWindow(note.id)}
          >
            <ToolIcon name="minimize" />
          </button>
          <button
            type="button"
            className="note-win-btn close"
            aria-label={`Close ${note.title}`}
            title="Close"
            onClick={() => void notesStore.getState().closeNoteWindow(note.id)}
          >
            ×
          </button>
        </div>
      </header>

      {/* Rich-Text Formatting Toolbar (matching Heading / B / I / Lists / fx UI) */}
      <div
        className="note-format-toolbar"
        role="toolbar"
        aria-label="Formatting toolbar"
        onMouseDown={(e) => {
          // Keep text selection alive in contentEditable while clicking toolbar controls
          e.preventDefault();
        }}
      >
        <div
          className="note-block-dropdown"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="note-block-trigger"
            aria-haspopup="listbox"
            aria-expanded={blockMenuOpen}
            onClick={() => setBlockMenuOpen((v) => !v)}
          >
            <span>{activeBlockMeta.label}</span>
            <span className="caret" aria-hidden="true">
              ▾
            </span>
          </button>
          {blockMenuOpen && (
            <div className="note-block-menu" role="listbox" aria-label="Text style">
              {BLOCK_STYLES.map((styleOpt) => (
                <button
                  key={styleOpt.tag}
                  type="button"
                  role="option"
                  aria-selected={formats.block === styleOpt.tag}
                  className={`note-block-option is-${styleOpt.tag} ${
                    formats.block === styleOpt.tag ? 'active' : ''
                  }`}
                  onClick={() => applyBlockStyle(styleOpt.tag)}
                >
                  <span>{styleOpt.label}</span>
                  {formats.block === styleOpt.tag && (
                    <span className="checkmark" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="note-toolbar-divider" aria-hidden="true" />

        <button
          type="button"
          className={`note-fmt-btn ${formats.bold ? 'active' : ''}`}
          aria-pressed={formats.bold}
          aria-label="Bold"
          title="Bold (Ctrl+B)"
          onClick={() => applyCommand('bold')}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={`note-fmt-btn ${formats.italic ? 'active' : ''}`}
          aria-pressed={formats.italic}
          aria-label="Italic"
          title="Italic (Ctrl+I)"
          onClick={() => applyCommand('italic')}
        >
          <em>I</em>
        </button>
        <button
          type="button"
          className={`note-fmt-btn ${formats.underline ? 'active' : ''}`}
          aria-pressed={formats.underline}
          aria-label="Underline"
          title="Underline (Ctrl+U)"
          onClick={() => applyCommand('underline')}
        >
          <u>U</u>
        </button>

        <span className="note-toolbar-divider" aria-hidden="true" />

        <button
          type="button"
          className={`note-fmt-btn ${formats.ul ? 'active' : ''}`}
          aria-pressed={formats.ul}
          aria-label="Bulleted list"
          title="Bulleted list"
          onClick={() => applyCommand('insertUnorderedList')}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <circle cx="5" cy="7" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="5" cy="17" r="1.2" fill="currentColor" stroke="none" />
            <path d="M9 7h11 M9 12h11 M9 17h11" />
          </svg>
        </button>
        <button
          type="button"
          className={`note-fmt-btn ${formats.ol ? 'active' : ''}`}
          aria-pressed={formats.ol}
          aria-label="Numbered list"
          title="Numbered list"
          onClick={() => applyCommand('insertOrderedList')}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 6h1.5v3 M4 9h3 M4 13h2.2l-2.2 2.5h2.4 M10 7h10 M10 12h10 M10 17h10" />
          </svg>
        </button>

        <span className="note-toolbar-divider" aria-hidden="true" />

        <button
          type="button"
          className={`note-fmt-btn ${formats.code ? 'active' : ''}`}
          aria-pressed={formats.code}
          aria-label="Inline code"
          title="Format selected text as monospace code"
          onClick={applyInlineCode}
        >
          <span className="note-fmt-fx">fx</span>
        </button>
        <button
          type="button"
          className="note-fmt-btn"
          aria-label="Clear formatting"
          title="Clear formatting"
          onClick={() => applyCommand('removeFormat')}
        >
          <span className="note-fmt-clear">Tx</span>
        </button>
      </div>

      <div
        ref={editorRef}
        className="note-editor-canvas"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Note content"
        data-placeholder="Write your private notes here…"
        onInput={() => syncContentToStore()}
        onKeyUp={() => setFormats(detectFormats(editorRef.current))}
        onMouseUp={() => setFormats(detectFormats(editorRef.current))}
        onBlur={() => syncContentToStore({ immediate: true })}
        onPaste={(e) => {
          const html = e.clipboardData?.getData('text/html');
          const text = e.clipboardData?.getData('text/plain') || '';
          e.preventDefault();
          const cleaned = html ? sanitizeNoteHtml(html) : plainTextToHtml(text);
          document.execCommand('insertHTML', false, cleaned);
          syncContentToStore();
        }}
      />

      <div
        className="note-resize-handle is-e"
        onPointerDown={(e) => startResizeWindow(e, 'e')}
      />
      <div
        className="note-resize-handle is-s"
        onPointerDown={(e) => startResizeWindow(e, 's')}
      />
      <div
        className="note-resize-handle is-se"
        onPointerDown={(e) => startResizeWindow(e, 'se')}
      />
    </section>
  );
}

export function MinimizedNotesBar() {
  const openWindows = useNotes((s) => s.openWindows);
  const notes = useNotes((s) => s.notes);
  const minimized = openWindows.filter((w) => w.minimized);
  if (minimized.length === 0) return null;

  return (
    <div className="minimized-notes-bar" aria-label="Minimized notes">
      {minimized.map((win) => {
        const note = notes.find((n) => n.id === win.noteId);
        if (!note) return null;
        return (
          <div key={win.noteId} className="minimized-note-pill">
            <button
              type="button"
              className="minimized-note-restore"
              title={`Restore "${note.title}"`}
              onClick={() => notesStore.getState().openNoteWindow(win.noteId)}
            >
              <ToolIcon name="notes" />
              <span>{note.title || 'Untitled Note'}</span>
            </button>
            <button
              type="button"
              className="minimized-note-close"
              aria-label={`Close ${note.title}`}
              onClick={() => void notesStore.getState().closeNoteWindow(win.noteId)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
