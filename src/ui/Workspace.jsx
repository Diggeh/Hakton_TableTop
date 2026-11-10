import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  computeDock,
  DEFAULT_LAYOUT,
  dockPanel,
  dockTarget,
  floatRect,
  GUTTER,
  INSET,
  LANES,
  readDockLayout,
  resizeColumns,
  resizeStack,
} from './workspaceLayout.js';
import './workspace.css';

const Layout = createContext(null);
const arrow = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const titles = {
  players: 'Players',
  dice: 'Dice tray',
  map: 'Map',
  assets: 'Assets',
  chat: 'Game log',
  soundboard: 'Soundboard',
};

function dockStyle(rect, lines) {
  return {
    gridColumn: LANES.indexOf(rect.lane) * 2 + 1,
    gridRow: `${lines.get(rect.y)} / ${lines.get(rect.bottom)}`,
  };
}

function load(key) {
  try {
    return readDockLayout(JSON.parse(localStorage.getItem(key)));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function removeSoundboard(layout) {
  return {
    ...layout,
    order: Object.fromEntries(
      LANES.map((lane) => [
        lane,
        layout.order[lane].filter((id) => id !== 'soundboard'),
      ]),
    ),
  };
}

export function useWorkspaceLayout(role, visible) {
  const key = `hakton:dock:v2:${role}`;
  const [saved, setSaved] = useState(() => load(key));
  const [preview, setPreview] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [bounds, setBounds] = useState({ width: 960, height: 536 });
  const root = useRef(null);
  const gesture = useRef(null);
  const reflow = useRef(null);
  const animations = useRef(new WeakMap());
  const current = preview ?? saved;
  const geometry = computeDock(current, visible, bounds);
  const soundboardDocked = LANES.some((lane) =>
    current.order[lane].includes('soundboard'),
  );

  useLayoutEffect(() => {
    const node = root.current;
    function measure() {
      const width = node.clientWidth;
      const height = node.clientHeight;
      if (width && height)
        setBounds((prior) =>
          prior.width === width && prior.height === height
            ? prior
            : { width, height },
        );
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!reflow.current) return;
    for (const [node, from] of reflow.current) {
      animations.current.get(node)?.cancel();
      const to = node.getBoundingClientRect();
      if (Math.hypot(from.x - to.x, from.y - to.y) > 1) {
        animations.current.set(
          node,
          node.animate(
            [
              {
                transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)`,
              },
              { transform: 'translate(0, 0)' },
            ],
            { duration: 145, easing: 'ease-out' },
          ),
        );
      }
    }
    reflow.current = null;
  }, [preview]);

  function rememberReflow(id) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    reflow.current = [
      ...root.current.querySelectorAll('[data-workspace-panel]:not([hidden])'),
    ]
      .filter(
        (node) =>
          node.dataset.workspacePanel !== id &&
          node.dataset.dock !== 'floating',
      )
      .map((node) => [node, node.getBoundingClientRect()]);
  }

  function save(next) {
    setSaved(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Layout stays available in memory. */
    }
  }

  function reset() {
    gesture.current = null;
    setPreview(null);
    setDragging(null);
    setSaved(DEFAULT_LAYOUT);
    try {
      localStorage.removeItem(key);
    } catch {
      /* The in-memory reset still applies. */
    }
  }

  function position(event) {
    const { left, top } = root.current.getBoundingClientRect();
    return { x: event.clientX - left, y: event.clientY - top };
  }

  function start(event, operation) {
    if (event.button !== 0 || !event.isPrimary || gesture.current) return;
    gesture.current = {
      ...operation,
      start: position(event),
      pointer: event.pointerId,
      layout: saved,
      geometry,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function previewMove(g, point, altKey) {
    const free = g.id === 'soundboard' && altKey;
    const scale = free ? 1 : Math.min(1, 280 / g.rect.width);
    const x = point.x - (g.start.x - g.rect.x) * scale;
    const y = point.y - (g.start.y - g.rect.y) * scale;
    root.current.style.setProperty('--workspace-drag-x', `${x}px`);
    root.current.style.setProperty('--workspace-drag-y', `${y}px`);

    const hit = { x: point.x - INSET, y: point.y - INSET };
    const slot = g.target && g.targetGeometry.rects[g.id];
    const insideSlot =
      slot &&
      hit.x >= slot.x &&
      hit.x <= slot.x + slot.width &&
      hit.y >= slot.y &&
      hit.y <= slot.bottom;
    const target = free
      ? null
      : insideSlot
        ? g.target
        : dockTarget(g.targetGeometry ?? g.geometry, g.id, hit.x, hit.y);
    const targetChanged =
      g.target?.lane !== target?.lane || g.target?.before !== target?.before;
    if (!g.started || targetChanged || g.free !== free) {
      setDragging({ id: g.id, target, rect: g.rect, scale, free });
    }
    if (!g.started || targetChanged) {
      if (target || g.target) rememberReflow(g.id);
      g.target = target;
      g.result = target
        ? dockPanel(g.layout, g.id, target.lane, target.before)
        : null;
      g.targetGeometry = target ? computeDock(g.result, visible, bounds) : null;
      setPreview(g.result);
    }
    if (!target && g.id === 'soundboard') {
      const floating = floatRect(
        { ...g.rect, x, y },
        bounds,
        g.collapsedHeight,
      );
      g.result = {
        ...removeSoundboard(g.layout),
        floating: {
          ...floating,
          height: g.collapsedHeight ? floatingRect().height : floating.height,
        },
      };
    }
    g.started = true;
    g.free = free;
  }

  function update(event) {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointer) return;
    const point = position(event);
    const dx = point.x - g.start.x;
    const dy = point.y - g.start.y;
    if (!g.started && !g.result && Math.hypot(dx, dy) < 4) return;
    if (g.type === 'move') {
      previewMove(g, point, event.altKey);
      return;
    }
    if (g.type === 'columns')
      g.result = resizeColumns(g.layout, g.geometry, g.split.lane, dx);
    if (g.type === 'stack')
      g.result = resizeStack(g.layout, g.geometry, g.split, dy);
    if (g.type === 'float') {
      const floating = floatRect(
        { ...g.rect, width: g.rect.width + dx, height: g.rect.height + dy },
        bounds,
        0,
      );
      g.result = { ...g.layout, floating };
    }
    setPreview(g.result);
  }

  function finish(event) {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointer) return;
    if (event.type !== 'pointerup' && g.target) rememberReflow(g.id);
    gesture.current = null;
    setDragging(null);
    setPreview(null);
    if (event.type === 'pointerup' && g.result) save(g.result);
  }

  function keyMove(id, event) {
    const g = gesture.current;
    if (g?.id === id) {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish({ pointerId: g.pointer, type: 'cancel' });
        event.currentTarget.releasePointerCapture(g.pointer);
      }
      return;
    }
    const offset = arrow[event.key];
    if (!offset) return;
    event.preventDefault();
    const source = LANES.find((lane) => current.order[lane].includes(id));
    if (id === 'soundboard' && event.altKey && !source) {
      const f = floatingRect();
      save({
        ...saved,
        floating: floatRect(
          { ...f, x: f.x + offset[0] * 24, y: f.y + offset[1] * 24 },
          bounds,
          0,
        ),
      });
      return;
    }
    const [dx, dy] = offset;
    const lane = LANES[LANES.indexOf(source ?? 'center') + dx];
    if (!lane) return;
    const ids = geometry.columns[lane].ids;
    if (dx || !source) {
      save(dockPanel(saved, id, lane, ids[0]));
    } else {
      const index = ids.indexOf(id);
      if (index + dy >= 0 && index + dy < ids.length) {
        save(dockPanel(saved, id, lane, ids[index + (dy > 0 ? 2 : -1)]));
      }
    }
  }

  function keyResize(event, operation) {
    const offset = arrow[event.key];
    if (!offset) return;
    const step = event.shiftKey ? 32 : 12;
    const delta = (operation.type === 'stack' ? offset[1] : offset[0]) * step;
    if (!delta && operation.type !== 'float') return;
    event.preventDefault();
    if (operation.type === 'columns')
      save(resizeColumns(saved, geometry, operation.split.lane, delta));
    if (operation.type === 'stack')
      save(resizeStack(saved, geometry, operation.split, delta));
    if (operation.type === 'float') {
      const f = floatingRect();
      save({
        ...saved,
        floating: floatRect(
          {
            ...f,
            width: f.width + offset[0] * step,
            height: f.height + offset[1] * step,
          },
          bounds,
          0,
        ),
      });
    }
  }

  function floatingRect(collapsed = 0) {
    return floatRect(
      current.floating ?? {
        x: bounds.width - 362,
        y: 36,
        width: 350,
        height: Math.min(620, bounds.height - 54),
      },
      bounds,
      collapsed,
    );
  }

  const pointerEvents = {
    onPointerMove: update,
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
  };

  return {
    dragging,
    geometry,
    root,
    reset,
    changed: saved !== DEFAULT_LAYOUT,
    soundboardDocked,
    floatingRect,
    undockSoundboard: () => save(removeSoundboard(saved)),
    moveHandle: (id, collapsedHeight) => ({
      ...pointerEvents,
      onPointerDown: (event) => {
        const rect = geometry.rects[id];
        start(event, {
          type: 'move',
          id,
          collapsedHeight,
          rect: rect
            ? { ...rect, x: rect.x + INSET, y: rect.y + INSET }
            : floatingRect(collapsedHeight),
        });
      },
      onKeyDown: (event) => keyMove(id, event),
    }),
    resizeHandle: (type, split) => ({
      ...pointerEvents,
      onPointerDown: (event) =>
        start(event, {
          type,
          split,
          rect: type === 'float' ? floatingRect() : null,
        }),
      onKeyDown: (event) => keyResize(event, { type, split }),
    }),
  };
}

export function Workspace({ layout, children }) {
  const { geometry, dragging } = layout;
  const target = dragging?.target;
  return (
    <Layout.Provider value={layout}>
      <div
        ref={layout.root}
        className="table-workspace customizable-workspace"
        style={{
          gridTemplateColumns: geometry.tracks,
          gridTemplateRows: geometry.rows,
        }}
      >
        {children}
        {geometry.horizontal.map((split) => (
          <button
            key={split.lane}
            className="workspace-split columns"
            type="button"
            role="separator"
            aria-orientation="vertical"
            aria-label={
              split.lane === 'right' && geometry.columns.center.width
                ? 'Resize right column'
                : 'Resize left column'
            }
            title="Drag to resize the columns"
            style={{ left: INSET + split.x }}
            {...layout.resizeHandle('columns', split)}
          />
        ))}
        {geometry.vertical.map((split) => {
          const col = geometry.columns[split.lane];
          return (
            <button
              key={split.first}
              className="workspace-split stack"
              type="button"
              role="separator"
              aria-orientation="horizontal"
              aria-label={`Resize ${titles[split.first]} and ${titles[split.second]}`}
              title="Drag to resize these panels"
              style={{
                top: INSET + split.y,
                left: INSET + col.x,
                width: col.width,
              }}
              {...layout.resizeHandle('stack', split)}
            />
          );
        })}
        {target && geometry.rects[dragging.id] && (
          <div
            className="workspace-dock-target"
            aria-hidden="true"
            data-lane={target.lane}
            style={dockStyle(geometry.rects[dragging.id], geometry.lines)}
          >
            <span>{titles[dragging.id]}</span>
          </div>
        )}
      </div>
    </Layout.Provider>
  );
}

export function WorkspacePanel({
  as: Element = 'section',
  panel,
  title,
  className = '',
  children,
  hidden = false,
  collapsedHeight = 0,
  titleGrip = false,
  focusOnShow = false,
  ...props
}) {
  const layout = useContext(Layout);
  const grip = useRef(null);
  const { rects, lines } = layout.geometry;
  const rect = rects[panel];
  const floating = panel === 'soundboard' && !layout.soundboardDocked;
  const f = floating ? layout.floatingRect(collapsedHeight) : null;
  const drag = layout.dragging?.id === panel ? layout.dragging : null;
  const style = drag
    ? {
        width: drag.rect.width,
        height: drag.rect.height,
        '--workspace-drag-scale': drag.scale,
        '--workspace-drag-clip': `${drag.free ? 0 : Math.max(0, drag.rect.height - 220 / drag.scale)}px`,
      }
    : floating
      ? { left: f.x, top: f.y, width: f.width, height: f.height }
      : rect
        ? dockStyle(rect, lines)
        : undefined;

  useLayoutEffect(() => {
    if (focusOnShow && !hidden) grip.current.focus({ preventScroll: true });
  }, [focusOnShow, hidden]);

  return (
    <Element
      {...props}
      data-workspace-panel={panel}
      data-dock={floating ? 'floating' : rect?.lane}
      className={`workspace-panel ${className}${floating ? ' is-floating' : ''}${collapsedHeight ? ' is-collapsed' : ''}${drag ? ' is-dragging' : ''}`}
      style={style}
      hidden={hidden}
    >
      <button
        ref={grip}
        type="button"
        className={`workspace-grip${titleGrip ? ' has-title' : ''}`}
        aria-label={`Move ${title.toLowerCase()}`}
        title={
          panel === 'soundboard'
            ? 'Drag to dock. Alt-drag to float.'
            : `Drag ${title} into a column or use the arrow keys`
        }
        {...layout.moveHandle(panel, collapsedHeight)}
      >
        {titleGrip ? title : <span aria-hidden="true" />}
      </button>
      {children}
      {floating && !collapsedHeight && (
        <button
          type="button"
          className="workspace-float-resize"
          aria-label="Resize floating soundboard"
          title="Drag to resize"
          {...layout.resizeHandle('float')}
        />
      )}
    </Element>
  );
}
