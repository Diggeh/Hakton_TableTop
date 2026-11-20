import { Circle, Group, Image as KonvaImage, Line, Rect, Text } from 'react-konva';
import { resolveAssetUrl } from '../net/socket.js';
import { useCanvasImage } from './useCanvasImage.js';
import { useSession } from '../store/sessionStore.js';

const MAP_BG = '#0d1f2d';
const MAP_EDGE = '#3f5f6f';

/**
 * Returns distinct atmospheric styling based on the active scene's name,
 * ensuring that switching scenes without uploaded image files still produces
 * immediate, unmistakable visual feedback on the canvas.
 */
function getSceneTheme(sceneName) {
  const name = (sceneName || '').toLowerCase();
  if (name.includes('drowned') || name.includes('water') || name.includes('sea') || name.includes('ocean')) {
    return {
      gradientStart: '#092532',
      gradientEnd: '#04141c',
      edge: '#2a6f8f',
      roomFill: '#0d3244',
      roomStroke: '#1c526d',
      altFill: '#0a3d53',
      labelColor: '#49c5b6',
    };
  }
  if (name.includes('dock') || name.includes('harbor') || name.includes('port')) {
    return {
      gradientStart: '#1d2228',
      gradientEnd: '#0f1418',
      edge: '#5a6b7c',
      roomFill: '#28313a',
      roomStroke: '#425160',
      altFill: '#1f3e3a',
      labelColor: '#e5a93c',
    };
  }
  if (name.includes('light') || name.includes('tower') || name.includes('beacon')) {
    return {
      gradientStart: '#26221c',
      gradientEnd: '#13110d',
      edge: '#8a7752',
      roomFill: '#363025',
      roomStroke: '#5a4f3b',
      altFill: '#4a3b22',
      labelColor: '#f5c35b',
    };
  }
  if (name.includes('dungeon') || name.includes('crypt') || name.includes('cavern') || name.includes('cave')) {
    return {
      gradientStart: '#1a1820',
      gradientEnd: '#0d0c10',
      edge: '#5b4f6e',
      roomFill: '#24202c',
      roomStroke: '#3d364a',
      altFill: '#1a2228',
      labelColor: '#9b7ad8',
    };
  }
  if (name.includes('forest') || name.includes('wood') || name.includes('grove')) {
    return {
      gradientStart: '#12251a',
      gradientEnd: '#08140d',
      edge: '#386b4d',
      roomFill: '#1a3625',
      roomStroke: '#2d563d',
      altFill: '#15412b',
      labelColor: '#65d992',
    };
  }

  // Deterministic procedural hash for any custom scene name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    gradientStart: `hsl(${hue}, 35%, 15%)`,
    gradientEnd: `hsl(${hue}, 45%, 7%)`,
    edge: `hsl(${hue}, 40%, 35%)`,
    roomFill: `hsl(${hue}, 30%, 18%)`,
    roomStroke: `hsl(${hue}, 35%, 28%)`,
    altFill: `hsl(${(hue + 30) % 360}, 30%, 20%)`,
    labelColor: `hsl(${hue}, 70%, 65%)`,
  };
}

/**
 * Renders distinct procedural floorplans per scene archetype when no map image is loaded.
 */
function renderProceduralLayout(theme, width, height, sceneName) {
  const name = (sceneName || '').toLowerCase();

  if (name.includes('drowned') || name.includes('water') || name.includes('sea') || name.includes('sanctuary')) {
    return (
      <Group listening={false}>
        {/* Central grand hall */}
        <Rect
          x={width * 0.22}
          y={height * 0.12}
          width={width * 0.56}
          height={height * 0.76}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={3}
        />
        {/* Sunken flooded basin */}
        <Rect
          x={width * 0.32}
          y={height * 0.28}
          width={width * 0.36}
          height={height * 0.44}
          fill={theme.altFill}
          stroke={theme.edge}
          strokeWidth={2}
          dash={[8, 4]}
        />
        {/* West wing cloister */}
        <Rect
          x={width * 0.06}
          y={height * 0.24}
          width={width * 0.16}
          height={height * 0.52}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={2}
        />
        {/* East wing apse */}
        <Rect
          x={width * 0.78}
          y={height * 0.24}
          width={width * 0.16}
          height={height * 0.52}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={2}
        />
      </Group>
    );
  }

  if (name.includes('dock') || name.includes('harbor') || name.includes('port')) {
    return (
      <Group listening={false}>
        {/* Coastal shoreline water basin */}
        <Rect
          x={0}
          y={height * 0.55}
          width={width}
          height={height * 0.45}
          fill={theme.altFill}
          stroke={theme.roomStroke}
          strokeWidth={2}
        />
        {/* Warehouse Alpha */}
        <Rect
          x={width * 0.08}
          y={height * 0.08}
          width={width * 0.38}
          height={height * 0.4}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={3}
        />
        {/* Warehouse Beta */}
        <Rect
          x={width * 0.54}
          y={height * 0.08}
          width={width * 0.38}
          height={height * 0.4}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={3}
        />
        {/* Pier 1 extending into water */}
        <Rect
          x={width * 0.22}
          y={height * 0.48}
          width={width * 0.1}
          height={height * 0.42}
          fill={theme.roomFill}
          stroke={theme.edge}
          strokeWidth={2}
        />
        {/* Pier 2 extending into water */}
        <Rect
          x={width * 0.68}
          y={height * 0.48}
          width={width * 0.1}
          height={height * 0.42}
          fill={theme.roomFill}
          stroke={theme.edge}
          strokeWidth={2}
        />
      </Group>
    );
  }

  if (name.includes('light') || name.includes('tower') || name.includes('beacon')) {
    const cx = width / 2;
    const cy = height / 2;
    const outerR = Math.min(width, height) * 0.38;
    const innerR = Math.min(width, height) * 0.2;
    const coreR = Math.min(width, height) * 0.08;
    return (
      <Group listening={false}>
        <Circle
          x={cx}
          y={cy}
          radius={outerR}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={4}
        />
        <Circle
          x={cx}
          y={cy}
          radius={innerR}
          fill={theme.altFill}
          stroke={theme.edge}
          strokeWidth={3}
        />
        <Circle
          x={cx}
          y={cy}
          radius={coreR}
          fill={theme.roomFill}
          stroke={theme.labelColor}
          strokeWidth={2}
        />
        <Rect
          x={cx - outerR - 20}
          y={cy - 20}
          width={40}
          height={40}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={2}
        />
        <Rect
          x={cx + outerR - 20}
          y={cy - 20}
          width={40}
          height={40}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={2}
        />
        <Rect
          x={cx - 20}
          y={cy - outerR - 20}
          width={40}
          height={40}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={2}
        />
        <Rect
          x={cx - 20}
          y={cy + outerR - 20}
          width={40}
          height={40}
          fill={theme.roomFill}
          stroke={theme.roomStroke}
          strokeWidth={2}
        />
      </Group>
    );
  }

  // Default / custom procedural scene layout
  return (
    <Group listening={false}>
      <Rect
        x={width * 0.08}
        y={height * 0.1}
        width={width * 0.38}
        height={height * 0.44}
        fill={theme.roomFill}
        stroke={theme.roomStroke}
        strokeWidth={2}
      />
      <Rect
        x={width * 0.52}
        y={height * 0.18}
        width={width * 0.4}
        height={height * 0.36}
        fill={theme.roomFill}
        stroke={theme.roomStroke}
        strokeWidth={2}
      />
      <Rect
        x={width * 0.32}
        y={height * 0.64}
        width={width * 0.36}
        height={height * 0.22}
        fill={theme.altFill}
        stroke={theme.roomStroke}
        strokeWidth={2}
      />
    </Group>
  );
}

/**
 * Static background layer. Listens to nothing so every pointer event falls
 * through to the canvas/pan handler or the token layer.
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

  if (!map || !width || !height) return null;

  const theme = getSceneTheme(map.name);

  return (
    <Group listening={false}>
      <Rect
        x={0}
        y={0}
        width={width}
        height={height}
        fillLinearGradientStartPoint={{ x: 0, y: 0 }}
        fillLinearGradientEndPoint={{ x: width, y: height }}
        fillLinearGradientColorStops={[
          0,
          theme.gradientStart || '#12293a',
          1,
          theme.gradientEnd || MAP_BG,
        ]}
      />

      {/* Fallback procedural scenery while the map image loads (or when none is stored). */}
      {!image && (
        <>
          {renderProceduralLayout(theme, width, height, map.name)}
          {map.name && (
            <Text
              x={width * 0.08 + 18}
              y={height * 0.1 + 18}
              text={map.name.toUpperCase()}
              fontSize={15}
              fontStyle="bold"
              fontFamily="system-ui, -apple-system, sans-serif"
              fill={theme.labelColor}
              opacity={0.65}
              listening={false}
            />
          )}
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
        stroke={theme.edge || MAP_EDGE}
        strokeWidth={3}
        strokeScaleEnabled={false}
        listening={false}
      />
    </Group>
  );
}
