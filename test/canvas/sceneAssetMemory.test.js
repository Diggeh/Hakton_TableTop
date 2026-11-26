import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionStore } from '../../src/store/sessionStore.js'
import { canvasStore } from '../../src/canvas/canvasStore.js'

test('sessionStore scene asset memory isolates and restores tokens, fog, and map layout across scenes', () => {
  // Clear initial state
  sessionStore.getState().setTokens({})
  canvasStore.getState().clearFog()

  // 1. On "Drowned Sanctuary": Set map layout, 2 character tokens and 1 prop
  sessionStore.getState().setMap({
    id: 'map-sanctuary',
    name: 'Drowned Sanctuary',
    imageUrl: 'sanctuary-hd.jpg',
    width: 2400,
    height: 1600,
  })
  sessionStore.getState().setSelectedMapAsset({
    id: 'asset-map-1',
    name: 'Drowned Sanctuary High-Res',
    url: 'sanctuary-hd.jpg',
  })
  sessionStore.getState().upsertToken({ id: 'tok-1', label: 'Mira', x: 100, y: 150 })
  sessionStore.getState().upsertToken({ id: 'tok-2', label: 'Thorne', x: 200, y: 250 })
  sessionStore.getState().upsertToken({ id: 'prop-1', label: 'Chest', x: 300, y: 350 })
  canvasStore.getState().addFogShape({ id: 'fog-ds', type: 'rect', x: 50, y: 50, width: 200, height: 200 })

  assert.equal(Object.keys(sessionStore.getState().tokens).length, 3)
  assert.equal(canvasStore.getState().fogShapes.length, 1)
  assert.equal(sessionStore.getState().map.name, 'Drowned Sanctuary')
  assert.equal(sessionStore.getState().map.imageUrl, 'sanctuary-hd.jpg')

  // 2. Switch from "Drowned Sanctuary" to "Greyhaven Docks":
  // Snapshot "Drowned Sanctuary"
  sessionStore.getState().saveSceneSnapshot('Drowned Sanctuary')

  // Load "Greyhaven Docks" (new scene with no previous assets)
  sessionStore.getState().loadSceneAssets('Greyhaven Docks')

  // Verify Scene 2 starts with a clean canvas and clears stale selectedMapAsset
  assert.deepEqual(sessionStore.getState().tokens, {})
  assert.deepEqual(canvasStore.getState().fogShapes, [])
  assert.equal(sessionStore.getState().selectedMapAsset, null)

  // 3. On "Greyhaven Docks": Set docks map layout and add a guard token
  sessionStore.getState().setMap({
    id: 'map-docks',
    name: 'Greyhaven Docks',
    imageUrl: 'docks-evening.png',
    width: 1800,
    height: 1200,
  })
  sessionStore.getState().setSelectedMapAsset({
    id: 'asset-map-2',
    name: 'Greyhaven Docks Evening',
    url: 'docks-evening.png',
  })
  sessionStore.getState().upsertToken({ id: 'tok-guard', label: 'Harbor Guard', x: 400, y: 400 })
  assert.equal(Object.keys(sessionStore.getState().tokens).length, 1)
  assert.ok(sessionStore.getState().tokens['tok-guard'])
  assert.equal(sessionStore.getState().map.name, 'Greyhaven Docks')
  assert.equal(sessionStore.getState().map.imageUrl, 'docks-evening.png')

  // 4. Switch back to "Drowned Sanctuary":
  // Snapshot "Greyhaven Docks"
  sessionStore.getState().saveSceneSnapshot('Greyhaven Docks')

  // Load "Drowned Sanctuary"
  sessionStore.getState().loadSceneAssets('Drowned Sanctuary')

  // Verify Scene 1's map layout, tokens and fog are faithfully restored
  const restoredTokens = sessionStore.getState().tokens
  assert.equal(Object.keys(restoredTokens).length, 3)
  assert.equal(restoredTokens['tok-1'].label, 'Mira')
  assert.equal(restoredTokens['tok-2'].label, 'Thorne')
  assert.equal(restoredTokens['prop-1'].label, 'Chest')
  // Verify Scene 2's guard is NOT present in Scene 1
  assert.equal(restoredTokens['tok-guard'], undefined)
  assert.equal(canvasStore.getState().fogShapes.length, 1)
  assert.equal(sessionStore.getState().map.name, 'Drowned Sanctuary')
  assert.equal(sessionStore.getState().map.imageUrl, 'sanctuary-hd.jpg')
  assert.equal(sessionStore.getState().selectedMapAsset.id, 'asset-map-1')

  // 5. Switch back to "Greyhaven Docks":
  sessionStore.getState().loadSceneAssets('Greyhaven Docks')
  assert.equal(Object.keys(sessionStore.getState().tokens).length, 1)
  assert.equal(sessionStore.getState().tokens['tok-guard'].label, 'Harbor Guard')
  assert.equal(sessionStore.getState().map.name, 'Greyhaven Docks')
  assert.equal(sessionStore.getState().map.imageUrl, 'docks-evening.png')
  assert.equal(sessionStore.getState().selectedMapAsset.id, 'asset-map-2')
})

test('sessionStore preserves token light properties and map tile tokens across normalization and scenes', () => {
  sessionStore.getState().setTokens({})

  // Upsert a character token with a torch light
  sessionStore.getState().upsertToken({
    id: 'char-torch',
    label: 'Torchbearer',
    x: 150,
    y: 150,
    light: {
      enabled: true,
      type: 'torch',
      range: 40,
    },
  })

  // Upsert a character token with a line of sight cone
  sessionStore.getState().upsertToken({
    id: 'char-scout',
    label: 'Ranger Scout',
    x: 250,
    y: 250,
    light: {
      enabled: true,
      type: 'vision',
      range: 60,
      angle: 90,
      rotation: 45,
    },
  })

  // Upsert a dragged Map tile token
  sessionStore.getState().upsertToken({
    id: 'map-tile-1',
    label: 'Crypt Room 1',
    x: 500,
    y: 500,
    isMap: true,
    imageUrl: 'crypt-room.png',
    width: 900,
    height: 700,
  })

  const tokens = sessionStore.getState().tokens
  assert.equal(tokens['char-torch'].light.enabled, true)
  assert.equal(tokens['char-torch'].light.type, 'torch')
  assert.equal(tokens['char-torch'].light.range, 40)

  assert.equal(tokens['char-scout'].light.enabled, true)
  assert.equal(tokens['char-scout'].light.type, 'vision')
  assert.equal(tokens['char-scout'].light.range, 60)
  assert.equal(tokens['char-scout'].light.angle, 90)
  assert.equal(tokens['char-scout'].light.rotation, 45)

  assert.equal(tokens['map-tile-1'].isMap, true)
  assert.equal(tokens['map-tile-1'].imageUrl, 'crypt-room.png')
  assert.equal(tokens['map-tile-1'].width, 900)
  assert.equal(tokens['map-tile-1'].height, 700)

  // Scene switch and restore
  sessionStore.getState().saveSceneSnapshot('Crypt Encounter')
  sessionStore.getState().loadSceneAssets('Tavern')
  assert.deepEqual(sessionStore.getState().tokens, {})

  sessionStore.getState().loadSceneAssets('Crypt Encounter')
  const restored = sessionStore.getState().tokens
  assert.equal(restored['char-torch'].light.enabled, true)
  assert.equal(restored['char-torch'].light.type, 'torch')
  assert.equal(restored['char-scout'].light.type, 'vision')
  assert.equal(restored['map-tile-1'].isMap, true)
  assert.equal(restored['map-tile-1'].imageUrl, 'crypt-room.png')

  // Editing restored tokens does not mutate the saved snapshot when switching away and back
  sessionStore.getState().upsertToken({
    ...restored['map-tile-1'],
    rotation: 90,
  })
  sessionStore.getState().loadSceneAssets('Tavern')
  sessionStore.getState().loadSceneAssets('Crypt Encounter')
  assert.equal(sessionStore.getState().tokens['map-tile-1'].rotation, 0)
})
