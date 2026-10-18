/** Seeds a default campaign/map/token so a fresh install renders something. */
export function seedIfEmpty(repos) {
  if (repos.maps.first()) return;
  const map = repos.maps.createWithCampaign('First Campaign', 'Starter Map');
  repos.tokens.upsert({ id: 'tok-demo-1', mapId: map.id, label: 'Hero', x: 140, y: 140 });
}
