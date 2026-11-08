import { Group, Image as KonvaImage, Rect } from 'react-konva';
import { resolveAssetUrl } from '../net/socket.js';
import { useCanvasImage } from './useCanvasImage.js';

const MAP_BG = '#0d1f2d';
const MAP_EDGE = '#3f5f6f';

/**
 * Static background layer. Listens to nothing so every pointer event falls
 * through to the canvas/pan handler or the token layer.
 */
export default function MapLayer({ map }) {
  const width = map?.width || 0;
  const height = map?.height || 0;
  const url = map?.imageUrl ? resolveAssetUrl(map.imageUrl) : null;
  const { image } = useCanvasImage(url);

  if (!map || !width || !height) return null;

  return (
    <Group listening={false}>
      <Rect
        x={0}
        y={0}
        width={width}
        height={height}
        fillLinearGradientStartPoint={{ x: 0, y: 0 }}
        fillLinearGradientEndPoint={{ x: width, y: height }}
        fillLinearGradientColorStops={[0, '#12293a', 1, MAP_BG]}
      />

      {/* Fallback texture while the map image loads (or when none is stored). */}
      {!image && (
        <>
          <Rect x={width * 0.1} y={height * 0.12} width={width * 0.34} height={height * 0.42} fill="#182f40" stroke="#2d4b5b" strokeWidth={2} />
          <Rect x={width * 0.52} y={height * 0.2} width={width * 0.36} height={height * 0.34} fill="#182f40" stroke="#2d4b5b" strokeWidth={2} />
          <Rect x={width * 0.37} y={height * 0.68} width={width * 0.28} height={height * 0.16} fill="#123347" stroke="#2d4b5b" strokeWidth={2} />
        </>
      )}

      {image && (
        <KonvaImage
          image={image}
          x={0}
          y={0}
          width={width}
          height={height}
          listening={false}
        />
      )}

      <Rect
        x={0}
        y={0}
        width={width}
        height={height}
        stroke={MAP_EDGE}
        strokeWidth={3}
        strokeScaleEnabled={false}
        listening={false}
      />
    </Group>
  );
}
