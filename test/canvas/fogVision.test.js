import test from 'node:test'
import assert from 'node:assert/strict'
import {
  segmentsIntersect,
  resolveTokenMoveWithWalls,
  computeVisibilityPolygon,
  isPointInFogShape,
  isPointInAnyFog,
  getFogShapeWalls,
  subtractOpenDoorsFromWalls,
  getAllCollisionWalls,
  findNearestWallSegment,
  detectClosedLoop
} from '../../src/canvas/fogVision.js'

test('segmentsIntersect detects crossing line segments', () => {
  const crosses = segmentsIntersect({ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 50, y: 0 }, { x: 50, y: 100 })
  assert.equal(crosses.intersects, true)
  assert.deepEqual(crosses.point, { x: 50, y: 50 })

  const parallel = segmentsIntersect({ x: 0, y: 10 }, { x: 100, y: 10 }, { x: 0, y: 20 }, { x: 100, y: 20 })
  assert.equal(parallel.intersects, false)
})

test('resolveTokenMoveWithWalls blocks movement across walls and closed doors, treats barriers as physical obstacles', () => {
  const walls = [
    { id: 'w1', p1: { x: 100, y: 0 }, p2: { x: 100, y: 200 }, isDoor: false, isOpen: false },
    { id: 'd1', p1: { x: 300, y: 0 }, p2: { x: 300, y: 200 }, isDoor: true, isOpen: false }
  ]

  // Blocked by wall w1: stops right in front of the wall (e.g. x=96 with buffer=4), does not pass through to x=150
  const blockedByWall = resolveTokenMoveWithWalls({ x: 50, y: 100 }, { x: 150, y: 100 }, walls)
  assert.equal(blockedByWall.blocked, true)
  assert.ok(blockedByWall.position.x <= 100, `Expected stopped x <= 100, got ${blockedByWall.position.x}`)
  assert.ok(blockedByWall.position.x >= 50, `Expected stopped x >= 50, got ${blockedByWall.position.x}`)

  // Blocked by closed door d1: stops right before x=300
  const blockedByClosedDoor = resolveTokenMoveWithWalls({ x: 250, y: 100 }, { x: 350, y: 100 }, walls)
  assert.equal(blockedByClosedDoor.blocked, true)
  assert.ok(blockedByClosedDoor.position.x <= 300, `Expected stopped x <= 300, got ${blockedByClosedDoor.position.x}`)
  assert.ok(blockedByClosedDoor.position.x >= 250, `Expected stopped x >= 250, got ${blockedByClosedDoor.position.x}`)

  // Open the door d1 -> token can pass through freely
  const openDoorWalls = [
    walls[0],
    { ...walls[1], isOpen: true }
  ]
  const allowedThroughOpenDoor = resolveTokenMoveWithWalls({ x: 250, y: 100 }, { x: 350, y: 100 }, openDoorWalls)
  assert.equal(allowedThroughOpenDoor.blocked, false)
  assert.deepEqual(allowedThroughOpenDoor.position, { x: 350, y: 100 })
})

test('getFogShapeWalls automatically extracts perimeter walls from fog shapes', () => {
  const fogShapes = [
    { id: 'fog1', type: 'rect', x: 100, y: 100, width: 200, height: 150 },
    { id: 'fog2', type: 'polygon', points: [0, 0, 100, 0, 100, 100, 0, 100] }
  ]

  const walls = getFogShapeWalls(fogShapes)
  // Rect produces 4 perimeter segments
  const rectWalls = walls.filter((w) => w.shapeId === 'fog1')
  assert.equal(rectWalls.length, 4)

  // Polygon with 4 vertices produces 4 perimeter segments
  const polyWalls = walls.filter((w) => w.shapeId === 'fog2')
  assert.equal(polyWalls.length, 4)

  // Combined collision walls merge explicit walls + auto walls
  const explicitWalls = [{ id: 'explicit1', p1: { x: 50, y: 50 }, p2: { x: 80, y: 80 } }]
  const combined = getAllCollisionWalls(explicitWalls, fogShapes)
  assert.equal(combined.length, 1 + 4 + 4)
})

test('findNearestWallSegment finds closest wall edge and projects point onto it for door mounting', () => {
  const walls = [
    { id: 'w1', p1: { x: 100, y: 0 }, p2: { x: 100, y: 200 } },
    { id: 'w2', p1: { x: 0, y: 500 }, p2: { x: 200, y: 500 } }
  ]

  // Point near vertical wall w1 at (105, 120)
  const nearest = findNearestWallSegment({ x: 105, y: 120 }, walls, 25)
  assert.ok(nearest)
  assert.equal(nearest.wall.id, 'w1')
  assert.equal(nearest.point.x, 100)
  assert.equal(nearest.point.y, 120)

  // Point in open space far from any wall
  const tooFar = findNearestWallSegment({ x: 800, y: 800 }, walls, 25)
  assert.equal(tooFar, null)
})

test('detectClosedLoop identifies brush loop closure and self-intersection', () => {
  // 1. Start and end are close: loop forms
  const closedBrush = [100, 100, 150, 100, 180, 160, 120, 180, 105, 105]
  const res1 = detectClosedLoop(closedBrush, 30)
  assert.equal(res1.isClosed, true)
  assert.ok(res1.points.length >= 6)

  // 2. Open stroke: ends are far apart
  const openBrush = [100, 100, 150, 100, 200, 150, 300, 200]
  const res2 = detectClosedLoop(openBrush, 30)
  assert.equal(res2.isClosed, false)
})

test('computeVisibilityPolygon casts line-of-sight rays blocked by walls and closed doors', () => {
  const origin = { x: 100, y: 100 }
  const closedDoorWall = [{ id: 'd1', p1: { x: 200, y: 0 }, p2: { x: 200, y: 300 }, isDoor: true, isOpen: false }]
  const bounds = { x: 0, y: 0, width: 600, height: 300 }

  const polyClosed = computeVisibilityPolygon(origin, closedDoorWall, bounds)
  assert.ok(polyClosed.length >= 3)

  // Every X coordinate in the visibility polygon should stop at or before the closed door at x=200
  for (const pt of polyClosed) {
    assert.ok(pt.x <= 200.5, `Expected ray X (${pt.x}) to stop at closed door x=200`)
  }

  // When door is opened, rays extend past x=200 up to bounds width=600
  const openDoorWall = [{ id: 'd1', p1: { x: 200, y: 0 }, p2: { x: 200, y: 300 }, isDoor: true, isOpen: true }]
  const polyOpen = computeVisibilityPolygon(origin, openDoorWall, bounds)
  let maxVx = -Infinity
  for (const pt of polyOpen) {
    if (pt.x > maxVx) maxVx = pt.x
  }
  assert.ok(maxVx > 500, `Expected ray X (${maxVx}) to extend beyond open door`)
})

test('isPointInFogShape checks rect, circle, polygon, and line brush shapes', () => {
  const rect = { type: 'rect', x: 10, y: 10, width: 100, height: 80 }
  assert.equal(isPointInFogShape({ x: 50, y: 50 }, rect), true)
  assert.equal(isPointInFogShape({ x: 200, y: 50 }, rect), false)

  const circle = { type: 'circle', x: 100, y: 100, radius: 40 }
  assert.equal(isPointInFogShape({ x: 120, y: 110 }, circle), true)
  assert.equal(isPointInFogShape({ x: 200, y: 200 }, circle), false)

  const polygon = { type: 'polygon', points: [0, 0, 100, 0, 100, 100, 0, 100] }
  assert.equal(isPointInFogShape({ x: 50, y: 50 }, polygon), true)
  assert.equal(isPointInFogShape({ x: 150, y: 50 }, polygon), false)

  const line = { type: 'line', points: [0, 0, 100, 0], strokeWidth: 40 }
  assert.equal(isPointInFogShape({ x: 50, y: 10 }, line), true)
  assert.equal(isPointInFogShape({ x: 50, y: 50 }, line), false)
})

test('isPointInAnyFog checks across collection of fog shapes', () => {
  const fogShapes = [
    { id: 'f1', type: 'rect', x: 100, y: 100, width: 200, height: 150 },
    { id: 'f2', type: 'circle', x: 500, y: 500, radius: 50 }
  ]
  assert.equal(isPointInAnyFog({ x: 150, y: 150 }, fogShapes), true)
  assert.equal(isPointInAnyFog({ x: 520, y: 510 }, fogShapes), true)
  assert.equal(isPointInAnyFog({ x: 50, y: 50 }, fogShapes), false)
  assert.equal(isPointInAnyFog({ x: 400, y: 400 }, fogShapes), false)
})

test('token outside fog can navigate around the entire perimeter without being tethered or blocked', () => {
  // Fog box from x=200..400, y=200..400
  const fogShapes = [{ id: 'room-1', type: 'rect', x: 200, y: 200, width: 200, height: 200 }]
  const walls = getFogShapeWalls(fogShapes)

  // Start at left of fog: (100, 300)
  let current = { x: 100, y: 300 }

  // Step 1: Move down to below fog: (100, 500)
  let res = resolveTokenMoveWithWalls(current, { x: 100, y: 500 }, walls)
  assert.equal(res.blocked, false)
  current = res.position
  assert.equal(isPointInAnyFog(current, fogShapes), false)

  // Step 2: Move right underneath fog: (300, 500)
  res = resolveTokenMoveWithWalls(current, { x: 300, y: 500 }, walls)
  assert.equal(res.blocked, false)
  current = res.position
  assert.equal(isPointInAnyFog(current, fogShapes), false)

  // Step 3: Move right past fog corner: (500, 500)
  res = resolveTokenMoveWithWalls(current, { x: 500, y: 500 }, walls)
  assert.equal(res.blocked, false)
  current = res.position
  assert.equal(isPointInAnyFog(current, fogShapes), false)

  // Step 4: Move up to right side of fog: (500, 300)
  res = resolveTokenMoveWithWalls(current, { x: 500, y: 300 }, walls)
  assert.equal(res.blocked, false)
  current = res.position
  assert.equal(isPointInAnyFog(current, fogShapes), false)

  // Step 5: Try to cross directly into fog: from (500, 300) toward (300, 300)
  res = resolveTokenMoveWithWalls(current, { x: 300, y: 300 }, walls, { buffer: 4 })
  assert.equal(res.blocked, true)
  // Must halt at wall x=400 with buffer=4 -> x >= 404
  assert.ok(res.position.x >= 403.9, `Expected halt outside wall, got x=${res.position.x}`)
  assert.equal(isPointInAnyFog(res.position, fogShapes), false)
})

test('computeVisibilityPolygon supports maxDistance range and directional cone arc', () => {
  const origin = { x: 300, y: 300 }
  const walls = [] // Open field

  // 1. 360 Torch with maxDistance 100
  const torchPoly = computeVisibilityPolygon(origin, walls, { maxDistance: 100 })
  assert.ok(torchPoly.length >= 8)
  for (const pt of torchPoly) {
    const dist = Math.hypot(pt.x - origin.x, pt.y - origin.y)
    assert.ok(dist <= 100.1, `Expected distance <= 100, got ${dist}`)
  }

  // 2. 90-degree Line of Sight Cone facing East (rotation=0) with maxDistance 150
  const conePoly = computeVisibilityPolygon(origin, walls, {
    maxDistance: 150,
    arc: { angle: 90, rotation: 0 },
  })
  assert.ok(conePoly.length >= 3)
  // Origin must be the apex or first point
  assert.equal(conePoly[0].x, origin.x)
  assert.equal(conePoly[0].y, origin.y)
  // Every point in the cone must have x >= origin.x (facing East)
  for (const pt of conePoly) {
    assert.ok(pt.x >= origin.x - 0.1, `Expected cone facing East x >= 300, got ${pt.x}`)
  }
})

test('open door on fog perimeter allows token entry/exit and light rays while closed door and remaining walls block', () => {
  const fogShapes = [{ id: 'fog-room', type: 'rect', x: 200, y: 100, width: 300, height: 300 }]
  const closedDoor = {
    id: 'door-west',
    p1: { x: 200, y: 210 },
    p2: { x: 200, y: 290 },
    isDoor: true,
    isOpen: false,
    wallId: 'fog-room_w3',
  }

  // 1. Closed door blocks movement into fog at y=250
  const closedWalls = getAllCollisionWalls([closedDoor], fogShapes)
  const blockedEnter = resolveTokenMoveWithWalls(
    { x: 140, y: 250 },
    { x: 260, y: 250 },
    closedWalls,
    { buffer: 12 },
  )
  assert.equal(blockedEnter.blocked, true)
  assert.ok(blockedEnter.position.x <= 200)

  // 2. Open door carves passage in fog perimeter wall so token can enter AND exit at y=250
  const openDoor = { ...closedDoor, isOpen: true }
  const openWalls = getAllCollisionWalls([openDoor], fogShapes)

  const enterThroughDoor = resolveTokenMoveWithWalls(
    { x: 140, y: 250 },
    { x: 260, y: 250 },
    openWalls,
    { buffer: 12 },
  )
  assert.equal(enterThroughDoor.blocked, false)
  assert.deepEqual(enterThroughDoor.position, { x: 260, y: 250 })
  assert.equal(isPointInAnyFog(enterThroughDoor.position, fogShapes), true)

  const exitThroughDoor = resolveTokenMoveWithWalls(
    { x: 260, y: 250 },
    { x: 140, y: 250 },
    openWalls,
    { buffer: 12 },
  )
  assert.equal(exitThroughDoor.blocked, false)
  assert.deepEqual(exitThroughDoor.position, { x: 140, y: 250 })
  assert.equal(isPointInAnyFog(exitThroughDoor.position, fogShapes), false)

  // 3. Remaining wall sections above/below the open door (e.g. y=150) STILL block passage
  const blockedAtWallBesideDoor = resolveTokenMoveWithWalls(
    { x: 140, y: 150 },
    { x: 260, y: 150 },
    openWalls,
    { buffer: 12 },
  )
  assert.equal(blockedAtWallBesideDoor.blocked, true)
  assert.ok(blockedAtWallBesideDoor.position.x <= 200)

  // 4. Visibility polygon passes through the open door into the fog interior (x > 200),
  //    but no ray reaches strictly inside the fog room while the door is closed
  const origin = { x: 140, y: 250 }
  const isStrictlyInsideRoom = (p) =>
    p.x > 200.5 && p.x < 499.5 && p.y > 100.5 && p.y < 399.5

  const polyClosed = computeVisibilityPolygon(origin, closedWalls, { x: 0, y: 0, width: 800, height: 600 }, { maxDistance: 300 })
  assert.equal(
    polyClosed.some(isStrictlyInsideRoom),
    false,
    'Expected no light rays inside fog room while door is closed',
  )

  const polyOpen = computeVisibilityPolygon(origin, openWalls, { x: 0, y: 0, width: 800, height: 600 }, { maxDistance: 300 })
  const interiorOpenPts = polyOpen.filter(isStrictlyInsideRoom)
  assert.ok(
    interiorOpenPts.some((p) => p.x > 350),
    'Expected open door light to penetrate fog room past x=350',
  )
})

test('resolveTokenMoveWithWalls slides tangentially along a wall without crossing when flush', () => {
  const walls = [{ id: 'w1', p1: { x: 200, y: 100 }, p2: { x: 200, y: 200 }, isDoor: false, isOpen: false }]
  // Frame 1: Token moves diagonally into wall from (196, 150) toward (240, 260); stops before crossing x=200
  const frame1 = resolveTokenMoveWithWalls({ x: 196, y: 150 }, { x: 240, y: 260 }, walls, { buffer: 4 })
  assert.equal(frame1.blocked, true)
  assert.ok(frame1.position.x < 200)

  // Frame 2: Continuing diagonal push while flush at buffer distance slides tangentially south along wall
  const frame2 = resolveTokenMoveWithWalls(frame1.position, { x: 240, y: 260 }, walls, { buffer: 4 })
  assert.equal(frame2.blocked, true)
  assert.equal(frame2.position.x, frame1.position.x)
  assert.ok(frame2.position.y > frame1.position.y, `Expected token to slide south along wall, got y=${frame2.position.y}`)
})

test('subtractOpenDoorsFromWalls ignores perpendicular neighbor edges touching a corner door', () => {
  const rectWalls = getFogShapeWalls([{ id: 'r1', type: 'rect', x: 100, y: 100, width: 200, height: 200 }])
  const topCornerDoor = {
    id: 'd-top',
    p1: { x: 102, y: 100 },
    p2: { x: 150, y: 100 },
    isDoor: true,
    isOpen: true,
    wallId: 'r1_w0',
  }
  const carved = subtractOpenDoorsFromWalls(rectWalls, [topCornerDoor])
  // West edge r1_w3 must remain full 200px height untouched
  const westEdge = carved.find((w) => w.id === 'r1_w3')
  assert.ok(westEdge)
  assert.equal(Math.hypot(westEdge.p2.x - westEdge.p1.x, westEdge.p2.y - westEdge.p1.y), 200)
})
