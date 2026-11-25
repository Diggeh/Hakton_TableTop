import { Shape } from 'react-konva';
import { canvasStore } from './canvasStore.js';

const MINOR = 'rgba(122, 186, 201, 0.16)';
const MAJOR = 'rgba(173, 252, 249, 0.26)';

/**
 * A single Konva shape draws every visible grid line. This scales to large
 * maps (thousands of cells) without creating thousands of React nodes.
 */
export default function GridLayer({ map, gridSize }) {
  const grid = gridSize > 0 ? gridSize : 70;

  const sceneFunc = (context, shape) => {
    const { viewport, viewportSize } = canvasStore.getState();
    const { x, y, scale } = viewport;
    if (!viewportSize.width || !viewportSize.height || !scale) return;

    // Stretch grid edge-to-edge across the entire VTT viewport in world/map coordinates.
    const left = -x / scale;
    const top = -y / scale;
    const right = (viewportSize.width - x) / scale;
    const bottom = (viewportSize.height - y) / scale;
    if (right <= left || bottom <= top) return;

    const firstColumn = Math.ceil(left / grid);
    const lastColumn = Math.floor(right / grid);
    const firstRow = Math.ceil(top / grid);
    const lastRow = Math.floor(bottom / grid);
    const isMajor = (n) => ((n % 5) + 5) % 5 === 0;

    const line = 1 / scale;

    context.save();

    // Minor lines.
    context.beginPath();
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      if (isMajor(column)) continue;
      const lineX = column * grid;
      context.moveTo(lineX, top);
      context.lineTo(lineX, bottom);
    }
    for (let row = firstRow; row <= lastRow; row += 1) {
      if (isMajor(row)) continue;
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
      if (!isMajor(column)) continue;
      const lineX = column * grid;
      context.moveTo(lineX, top);
      context.lineTo(lineX, bottom);
    }
    for (let row = firstRow; row <= lastRow; row += 1) {
      if (!isMajor(row)) continue;
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
