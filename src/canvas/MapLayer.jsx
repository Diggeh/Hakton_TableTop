import { Image as KonvaImage } from 'react-konva';
import { resolveAssetUrl } from '../net/socket.js';
import { useCanvasImage } from './useCanvasImage.js';
import { useSession } from '../store/sessionStore.js';

/**
 * Static background layer. Renders an uploaded map image only when explicitly
 * attached to the map row; otherwise leaves a clean dark tabletop for the grid
 * and placed scene/map objects.
 */
export default function MapLayer({ map }) {
  const width = map?.width || 0;
  const height = map?.height || 0;
  const selectedMapAsset = useSession((s) => s.selectedMapAsset);
  const rawUrl =
    map?.imageUrl ||
    selectedMapAsset?.url ||
    (selectedMapAsset?.id ? `/assets/${selectedMapAsset.id}/file` : null);
  const url = rawUrl ? resolveAssetUrl(rawUrl) : null;
  const { image } = useCanvasImage(url);

  if (!map || !width || !height || !image) return null;

  return (
    <KonvaImage
      image={image}
      x={0}
      y={0}
      width={width}
      height={height}
      listening={false}
    />
  );
}
