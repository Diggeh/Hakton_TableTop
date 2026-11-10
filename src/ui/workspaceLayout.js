export const LANES = ['left', 'center', 'right'];
export const GUTTER = 10;
export const INSET = 12;
export const DEFAULT_LAYOUT = {
  order: {
    left: ['players', 'dice'],
    center: ['map', 'assets'],
    right: ['chat'],
  },
  widths: { left: 184, right: 272 },
  weights: {},
  floating: null,
};

const panels = {
  players: { width: 120, height: 86, weight: 140 },
  dice: { width: 126, height: 180, weight: 360 },
  map: { width: 312, height: 205, weight: 530 },
  assets: { width: 220, height: 150, weight: 230 },
  chat: { width: 215, height: 215, weight: 400 },
  soundboard: { width: 248, height: 155, weight: 410 },
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function readDockLayout(raw) {
  if (!raw || !LANES.every((lane) => Array.isArray(raw.order?.[lane])))
    return DEFAULT_LAYOUT;
  const seen = new Set();
  const order = Object.fromEntries(
    LANES.map((lane) => [
      lane,
      raw.order[lane].filter((id) => {
        if (!Object.hasOwn(panels, id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      }),
    ]),
  );
  for (const lane of LANES) {
    order[lane].push(
      ...DEFAULT_LAYOUT.order[lane].filter((id) => !seen.has(id)),
    );
  }
  const positive = (n) => Number.isFinite(n) && n > 0;
  const widths = Object.fromEntries(
    ['left', 'right'].map((lane) => [
      lane,
      positive(raw.widths?.[lane])
        ? raw.widths[lane]
        : DEFAULT_LAYOUT.widths[lane],
    ]),
  );
  const weights = Object.fromEntries(
    Object.keys(panels).flatMap((id) =>
      positive(raw.weights?.[id]) ? [[id, raw.weights[id]]] : [],
    ),
  );
  const f = raw.floating;
  const floating =
    f &&
    Number.isFinite(f.x) &&
    Number.isFinite(f.y) &&
    positive(f.width) &&
    positive(f.height)
      ? { x: f.x, y: f.y, width: f.width, height: f.height }
      : null;
  return { order, widths, weights, floating };
}

function columnWidths(layout, groups, width) {
  const occupied = LANES.filter((lane) => groups[lane].length);
  const active = occupied.length ? occupied : ['center'];
  const usable = Math.max(active.length, width - (active.length - 1) * GUTTER);
  const minimums = Object.fromEntries(
    active.map((lane) => [
      lane,
      Math.max(
        lane === 'center' ? 300 : 126,
        ...groups[lane].map((id) => panels[id].width),
      ),
    ]),
  );
  const totalMin = Object.values(minimums).reduce(
    (sum, value) => sum + value,
    0,
  );
  const scale = Math.min(1, usable / totalMin);
  const fill = active.includes('center') ? 'center' : active[active.length - 1];
  let remaining = usable;
  const sizes = { left: 0, center: 0, right: 0 };
  for (const lane of active.filter((lane) => lane !== fill)) {
    const otherMinimums = active
      .filter((other) => other !== lane && !sizes[other])
      .reduce((sum, other) => sum + minimums[other] * scale, 0);
    sizes[lane] = clamp(
      layout.widths[lane],
      minimums[lane] * scale,
      remaining - otherMinimums,
    );
    remaining -= sizes[lane];
  }
  sizes[fill] = remaining;
  return sizes;
}

function panelHeights(ids, layout, visible, height) {
  const usable = Math.max(ids.length, height - (ids.length - 1) * GUTTER);
  const collapsed = ids.filter((id) => visible[id]);
  const expanded = ids.filter((id) => !visible[id]);
  const fixed = collapsed.reduce((sum, id) => sum + visible[id], 0);
  const collapsedScale = Math.min(
    1,
    usable / Math.max(1, fixed + expanded.length * 40),
  );
  const heights = Object.fromEntries(
    collapsed.map((id) => [id, visible[id] * collapsedScale]),
  );
  let remaining = Math.max(0, usable - fixed * collapsedScale);
  const minimumTotal = expanded.reduce((sum, id) => sum + panels[id].height, 0);
  const scale = Math.min(1, remaining / Math.max(1, minimumTotal));
  const weights = Object.fromEntries(
    expanded.map((id) => [id, layout.weights[id] ?? panels[id].weight]),
  );
  let pending = expanded;
  while (pending.length) {
    const weightTotal = pending.reduce((sum, id) => sum + weights[id], 0);
    const limited = pending.filter(
      (id) =>
        (remaining * weights[id]) / weightTotal <
        panels[id].height * scale - 0.01,
    );
    if (!limited.length) {
      for (const id of pending)
        heights[id] = (remaining * weights[id]) / weightTotal;
      break;
    }
    for (const id of limited) {
      heights[id] = panels[id].height * scale;
      remaining -= heights[id];
    }
    pending = pending.filter((id) => !limited.includes(id));
  }
  if (ids.length === 1 && ids[0] === 'players' && !visible.players) {
    heights.players = Math.min(heights.players, 170);
  }
  return heights;
}

export function computeDock(layout, visible, bounds) {
  const width = Math.max(1, bounds.width - 2 * INSET);
  const height = Math.max(1, bounds.height - 2 * INSET);
  const groups = Object.fromEntries(
    LANES.map((lane) => [
      lane,
      layout.order[lane].filter((id) => Object.hasOwn(visible, id)),
    ]),
  );
  const sizes = columnWidths(layout, groups, width);
  const columns = {};
  const rects = {};
  const rowStops = new Set([0, height]);
  const horizontal = [];
  const vertical = [];
  let x = 0;
  for (const lane of LANES) {
    const ids = groups[lane];
    const w = sizes[lane];
    columns[lane] = { x, width: w, ids };
    if (!w) continue;
    if (x > 0) horizontal.push({ lane, x: x - GUTTER / 2 });
    let y = 0;
    const heights = panelHeights(ids, layout, visible, height);
    const expanded = ids.filter((id) => !visible[id]);
    for (const id of ids) {
      const h = heights[id];
      const top = Math.round(y);
      const bottom = Math.max(top + 1, Math.round(y + h));
      rects[id] = { x, y: top, width: w, height: bottom - top, lane, bottom };
      rowStops.add(top);
      rowStops.add(bottom);
      const index = expanded.indexOf(id);
      if (index >= 0 && index < expanded.length - 1) {
        vertical.push({
          lane,
          first: id,
          second: expanded[index + 1],
          y: bottom + GUTTER / 2,
        });
      }
      y += h + GUTTER;
    }
    x += w + GUTTER;
  }
  const stops = [...rowStops].sort((a, b) => a - b);
  const lines = new Map(stops.map((y, i) => [y, i + 1]));
  const rows = stops
    .slice(1)
    .map((y, i) => `${y - stops[i]}px`)
    .join(' ');
  const tracks = [
    sizes.left,
    sizes.left && (sizes.center || sizes.right) ? GUTTER : 0,
    sizes.center,
    sizes.center && sizes.right ? GUTTER : 0,
    sizes.right,
  ]
    .map((size) => `${size}px`)
    .join(' ');
  return {
    width,
    height,
    columns,
    rects,
    lines,
    rows,
    tracks,
    horizontal,
    vertical,
  };
}

export function dockPanel(layout, id, lane, before) {
  const order = Object.fromEntries(
    LANES.map((key) => [key, layout.order[key].filter((item) => item !== id)]),
  );
  const target = order[lane];
  const index = before ? target.indexOf(before) : -1;
  target.splice(index < 0 ? target.length : index, 0, id);
  return { ...layout, order };
}

export function dockTarget(geometry, id, x, y) {
  const { columns, width, height, rects } = geometry;
  if (x < -INSET || x > width + INSET || y < -INSET || y > height + INSET)
    return null;
  const missingEdge = Math.min(80, width * 0.12);
  const lane =
    !columns.left.width && x < missingEdge
      ? 'left'
      : !columns.right.width && x > width - missingEdge
        ? 'right'
        : !columns.center.width && Math.abs(x - width / 2) < missingEdge / 2
          ? 'center'
          : (LANES.find(
              (key) =>
                columns[key].width &&
                x <= columns[key].x + columns[key].width + GUTTER / 2,
            ) ?? LANES.findLast((key) => columns[key].width));
  const column = columns[lane];
  const ids = column.ids.filter((item) => item !== id);
  const before = ids.find((item) => y < rects[item].y + rects[item].height / 2);
  return { lane, before };
}

export function resizeColumns(layout, geometry, lane, delta) {
  const active = LANES.filter((key) => geometry.columns[key].width);
  const before = active[active.indexOf(lane) - 1];
  const side = lane === 'right' && before === 'center' ? 'right' : before;
  if (!side || side === 'center') return layout;
  const sideColumn = geometry.columns[side];
  const other = geometry.columns[side === before ? lane : before];
  const min = (column) =>
    Math.min(
      column.width,
      Math.max(126, ...column.ids.map((id) => panels[id].width)),
    );
  const size = clamp(
    sideColumn.width + (side === before ? delta : -delta),
    min(sideColumn),
    sideColumn.width + other.width - min(other),
  );
  return { ...layout, widths: { ...layout.widths, [side]: size } };
}

export function resizeStack(layout, geometry, split, delta) {
  const { first, second, lane } = split;
  const a = geometry.rects[first].height;
  const b = geometry.rects[second].height;
  const change = clamp(
    delta,
    Math.min(a, panels[first].height) - a,
    b - Math.min(b, panels[second].height),
  );
  const weights = Object.fromEntries(
    geometry.columns[lane].ids.map((id) => [id, geometry.rects[id].height]),
  );
  weights[first] = a + change;
  weights[second] = b - change;
  return { ...layout, weights: { ...layout.weights, ...weights } };
}

export function floatRect(rect, bounds, collapsed) {
  const width = clamp(
    rect.width,
    Math.min(248, bounds.width),
    bounds.width - 2 * INSET,
  );
  const height =
    collapsed ||
    clamp(rect.height, Math.min(155, bounds.height), bounds.height - 2 * INSET);
  return {
    x: clamp(rect.x, INSET, bounds.width - INSET - width),
    y: clamp(rect.y, INSET, bounds.height - INSET - height),
    width,
    height,
  };
}
