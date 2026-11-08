/**
 * Builds the server-authoritative board blueprint for a campaign.
 *
 * Only the backend calls this, and it reads exclusively from the normalized
 * `maps`/`tokens` tables. A client can therefore never smuggle token
 * coordinates into the recovery snapshot.
 *
 * @param {ReturnType<typeof import('../../database/repositories.js').createRepositories>} repos
 * @param {number|string} campaignId
 */
export function buildBoardSnapshot(repos, campaignId) {
  const maps = repos?.maps?.listByCampaign ? repos.maps.listByCampaign(campaignId) : [];
  const active =
    (repos?.maps?.activeForCampaign ? repos.maps.activeForCampaign(campaignId) : null) ??
    maps[0] ??
    null;
  const tokens = active && repos?.tokens ? repos.tokens.listByMap(active.id) : [];

  return {
    version: 1,
    campaignId,
    activeMapId: active?.id ?? null,
    maps: maps.map((map) => ({
      id: map.id,
      name: map.name,
      gridSize: map.grid_size ?? 70,
      width: map.width,
      height: map.height,
      imageFile: map.image_file ?? null,
    })),
    tokens: tokens.map((token) => ({
      id: token.id,
      mapId: token.map_id ?? null,
      label: token.label,
      x: token.x,
      y: token.y,
      ownerId: token.owner_id ?? null,
      locked: Boolean(token.locked),
      color: token.color ?? null,
    })),
    settings: { gridSize: active?.grid_size ?? 70 },
    overlays: { fog: [], drawings: [], markers: [] },
    tokenOrder: tokens.map((token) => token.id),
    capturedAt: new Date().toISOString(),
  };
}
