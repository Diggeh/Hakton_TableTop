import { Shape } from 'react-konva';
import { DEFAULT_GRID_SIZE } from '../../shared/events.js';
import { canvasStore, useCanvas } from './canvasStore.js';

const GRID_LINE_DARK = 'rgba(116, 206, 224, 0.16)';
const GRID_LINE_LIGHT = 'rgba(38, 66, 72, 0.22)';

/**
 * A single Konva shape draws every visible grid line uniformly. This scales
 * to large maps (thousands of cells) without creating thousands of React nodes.
 */
export default function GridLayer({ gridSize }) {
  const grid = gridSize > 0 ? gridSize : DEFAULT_GRID_SIZE;
  const canvasTheme = useCanvas((state) => state.canvasTheme);
  const strokeColor = canvasTheme === 'light' ? GRID_LINE_LIGHT : GRID_LINE_DARK;

  const sceneFunc = (context) => {
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

    const line = 1 / scale;

    context.save();
    context.beginPath();
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const lineX = column * grid;
      context.moveTo(lineX, top);
      context.lineTo(lineX, bottom);
    }
    for (let row = firstRow; row <= lastRow; row += 1) {
      const lineY = row * grid;
      context.moveTo(left, lineY);
      context.lineTo(right, lineY);
    }
    context.setAttr('strokeStyle', strokeColor);
    context.setAttr('lineWidth', line);
    context.stroke();
    context.restore();
  };

  return (
    <Shape
      key={canvasTheme}
      sceneFunc={sceneFunc}
      listening={false}
      perfectDrawEnabled={false}
      strokeScaleEnabled={false}
    />
  );
}
