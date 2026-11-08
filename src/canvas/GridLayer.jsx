import { Shape } from 'react-konva';
import { canvasStore } from './canvasStore.js';

const MINOR = 'rgba(122, 186, 201, 0.16)';
const MAJOR = 'rgba(173, 252, 249, 0.26)';

/**
 * A single Konva shape draws every visible grid line. This scales to large
 * maps (thousands of cells) without creating thousands of React nodes.
 */
export default function GridLayer({ map, gridSize }) {
  const width = map?.width || 0;
  const height = map?.height || 0;
  const grid = gridSize > 0 ? gridSize : 70;

  const sceneFunc = (context, shape) => {
    if (!width || !height) return;
    const { viewport, viewportSize } = canvasStore.getState();
    const { x, y, scale } = viewport;

    // Map-space rectangle currently on screen, clamped to the map.
    const left = Math.max(0, -x / scale);
    const top = Math.max(0, -y / scale);
    const right = Math.min(width, (viewportSize.width - x) / scale);
    const bottom = Math.min(height, (viewportSize.height - y) / scale);
    if (right <= left || bottom <= top) return;

    const firstColumn = Math.ceil(left / grid);
    const lastColumn = Math.floor(right / grid);
    const firstRow = Math.ceil(top / grid);
    const lastRow = Math.floor(bottom / grid);

    const line = 1 / scale;

    context.save();

    // Minor lines.
    context.beginPath();
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      if (column % 5 === 0) continue;
      const lineX = column * grid;
      context.moveTo(lineX, top);
      context.lineTo(lineX, bottom);
    }
    for (let row = firstRow; row <= lastRow; row += 1) {
      if (row % 5 === 0) continue;
      const lineY = row * grid;
      context.moveTo(left, lineY);
      context.lineTo(right, lineY);
    }
    context.setAttr('strokeStyle', MINOR);
    context.setAttr('lineWidth', line);
    context.stroke();

    // Major lines every five squares.
    context.beginPath();
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      if (column % 5 !== 0) continue;
      const lineX = column * grid;
      context.moveTo(lineX, top);
      context.lineTo(lineX, bottom);
    }
    for (let row = firstRow; row <= lastRow; row += 1) {
      if (row % 5 !== 0) continue;
      const lineY = row * grid;
      context.moveTo(left, lineY);
      context.lineTo(right, lineY);
    }
    context.setAttr('strokeStyle', MAJOR);
    context.setAttr('lineWidth', line * 1.6);
    context.stroke();

    context.restore();
  };

  return (
    <Shape
      sceneFunc={sceneFunc}
      listening={false}
      perfectDrawEnabled={false}
      strokeScaleEnabled={false}
    />
  );
}
