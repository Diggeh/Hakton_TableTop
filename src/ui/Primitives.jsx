import { useEffect, useId, useRef } from 'react';
export function Mark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M20 3 36 12v16L20 37 4 28V12Z M4 12l16 9 16-9M20 21v16M20 3v18"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="m12 16 8-5 8 5-8 13Z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
export function IconButton({ label, children, ...props }) {
  return (
    <button className="icon-button" title={label} aria-label={label} {...props}>
      {children}
    </button>
  );
}
export function Modal({ title, children, onClose }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <IconButton label="Close dialog" onClick={onClose}>
          ×
        </IconButton>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Tabs({ items, value, onChange, label }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item}
          role="tab"
          tabIndex={value === item ? 0 : -1}
          aria-selected={value === item}
          onClick={() => onChange(item)}
          onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
              return;
            e.preventDefault();
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? items.length - 1
                  : (index + (e.key === 'ArrowRight' ? 1 : -1) + items.length) %
                    items.length;
            onChange(items[next]);
            e.currentTarget.parentElement.children[next].focus();
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
