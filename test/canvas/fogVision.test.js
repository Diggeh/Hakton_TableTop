import test from 'node:test'
import assert from 'node:assert/strict'
import {
  segmentsIntersect,
  resolveTokenMoveWithWalls,
  computeVisibilityPolygon,
  isPointInFogShape
} from '../../src/canvas/fogVision.js'

test('segmentsIntersect detects crossing line segments', () => {
  const crosses = segmentsIntersect({ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 50, y: 0 }, { x: 50, y: 100 })
  assert.equal(crosses.intersects, true)
  assert.deepEqual(crosses.point, { x: 50, y: 50 })

  const parallel = segmentsIntersect({ x: 0, y: 10 }, { x: 100, y: 10 }, { x: 0, y: 20 }, { x: 100, y: 20 })
  assert.equal(parallel.intersects, false)
})

test('resolveTokenMoveWithWalls blocks movement across walls and closed doors, allows open doors', () => {
  const walls = [
    { id: 'w1', p1: { x: 100, y: 0 }, p2: { x: 100, y: 200 }, isDoor: false, isOpen: false },
    { id: 'd1', p1: { x: 300, y: 0 }, p2: { x: 300, y: 200 }, isDoor: true, isOpen: false }
  ]

  // Blocked by wall w1
  const blockedByWall = resolveTokenMoveWithWalls({ x: 50, y: 100 }, { x: 150, y: 100 }, walls)
  assert.equal(blockedByWall.blocked, true)
  assert.deepEqual(blockedByWall.position, { x: 50, y: 100 })

  // Blocked by closed door d1
  const blockedByClosedDoor = resolveTokenMoveWithWalls({ x: 250, y: 100 }, { x: 350, y: 100 }, walls)
  assert.equal(blockedByClosedDoor.blocked, true)
  assert.deepEqual(blockedByClosedDoor.position, { x: 250, y: 100 })

  // Open the door d1 -> token can pass through
  const openDoorWalls = [
    walls[0],
    { ...walls[1], isOpen: true }
  ]
  const allowedThroughOpenDoor = resolveTokenMoveWithWalls({ x: 250, y: 100 }, { x: 350, y: 100 }, openDoorWalls)
  assert.equal(allowedThroughOpenDoor.blocked, false)
  assert.deepEqual(allowedThroughOpenDoor.position, { x: 350, y: 100 })
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
