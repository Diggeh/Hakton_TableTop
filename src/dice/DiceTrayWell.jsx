import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { createDieMesh, expandPhysicalDice } from './geometry/DiceMeshFactory.js';
import { faceUpQuaternion } from './geometry/polyhedra.js';

/**
 * Computes the exact quaternion that orients a die of `kind` so the face with
 * `targetValue` is flat on top facing directly toward the camera (+Z) and right-side up (+Y).
 */
export function quaternionForFaceUp(kind, targetValue) {
  const q = faceUpQuaternion(kind, targetValue);
  return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
}

/**
 * Arranges `count` items into a compact grid inside `[-halfW, halfW] x [-halfH, halfH]`.
 */
function layoutGridPositions(count, halfW, halfH) {
  if (count <= 0) return { positions: [], scale: 1 };
  const aspect = halfW / Math.max(0.1, halfH);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * aspect)));
  const rows = Math.max(1, Math.ceil(count / cols));

  const cellW = (halfW * 1.68) / cols;
  const cellH = (halfH * 1.68) / rows;
  const cellSize = Math.min(cellW, cellH);
  const scale = Math.max(0.36, Math.min(1.05, cellSize / 1.55));

  const positions = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inThisRow = Math.min(cols, count - row * cols);
    const col = i % cols;
    const x = (col - (inThisRow - 1) / 2) * Math.min(cellW, 1.55 * scale);
    const y = ((rows - 1) / 2 - row) * Math.min(cellH, 1.55 * scale);
    positions.push([x, y, 0]);
  }
  return { positions, scale };
}

/**
 * Top dark well inside the Dice Tray.
 *
 * - Displays the 3D polyhedral meshes for the dice currently picked by the player.
 * - Overlays a translucent centered "ROLL" button on top of the 3D dice when dice are selected.
 * - After a roll on the main board settles and slowly fades out, displays the rolled 3D dice
 *   with their exact rolled face numbers on top (+Z) and a translucent centered box (same
 *   dimensions and position as the ROLL button) showing the final rolled total.
 */
export default function DiceTrayWell({
  selectedDice,
  settledRoll,
  isBoardRolling,
  onRoll,
}) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const threeRef = useRef(null);

  const hasSelection = selectedDice.length > 0;
  const showSettled = !hasSelection && !isBoardRolling && Boolean(settledRoll);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return undefined;

    const width = host.clientWidth || 160;
    const height = host.clientHeight || 180;

    // Orthographic-feel narrow FOV so even off-center dice in a grid show their top (+Z) face directly
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(22, width / Math.max(1, height), 0.5, 60);
    camera.position.set(0, 0, 17);
    camera.lookAt(0, 0, 0);

    const ambient = new THREE.AmbientLight(0xd8ecff, 1.55);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.9);
    keyLight.position.set(4, 7, 18);
    const rimLight = new THREE.DirectionalLight(0xadfcf9, 0.9);
    rimLight.position.set(-6, -5, 14);
    scene.add(ambient, keyLight, rimLight);

    let renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(
        typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1,
      );
      renderer.setSize(width, height, false);
    } catch {
      renderer = null;
    }

    const state = {
      scene,
      camera,
      renderer,
      meshes: [],
      rafId: null,
      width,
      height,
    };
    threeRef.current = state;

    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      if (!w || !h) return;
      state.width = w;
      state.height = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (renderer) {
        renderer.setSize(w, h, false);
        renderer.render(scene, camera);
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      if (state.rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(state.rafId);
      }
      for (const m of state.meshes) scene.remove(m);
      state.meshes = [];
      if (renderer) renderer.dispose();
      threeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const state = threeRef.current;
    if (!state) return undefined;

    if (state.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    for (const m of state.meshes) state.scene.remove(m);
    state.meshes = [];

    const aspect = state.width / Math.max(1, state.height);
    const vFovRad = (state.camera.fov * Math.PI) / 180;
    const halfH = Math.tan(vFovRad / 2) * state.camera.position.z * 0.86;
    const halfW = halfH * aspect * 0.86;

    // Mode 1: Player is selecting dice -> show 3D meshes for every picked die
    if (hasSelection) {
      const { positions, scale } = layoutGridPositions(selectedDice.length, halfW, halfH);
      const baseQuats = [];

      selectedDice.forEach((d, idx) => {
        const mesh = createDieMesh(d.variant);
        mesh.scale.setScalar(scale);
        const [x, y, z] = positions[idx];
        mesh.position.set(x, y, z);

        const maxFace = d.kind === 'd4' ? 4 : Number(d.kind.slice(1));
        const baseQuat = quaternionForFaceUp(d.kind, maxFace);
        mesh.quaternion.copy(baseQuat);
        baseQuats.push(baseQuat);

        state.scene.add(mesh);
        state.meshes.push(mesh);
      });

      const start = performance.now();
      const spinAxisY = new THREE.Vector3(0, 1, 0);
      const spinAxisX = new THREE.Vector3(1, 0, 0);
      const qOffset = new THREE.Quaternion();
      const qTilt = new THREE.Quaternion();

      const animatePreview = (now) => {
        const t = (now - start) * 0.001;
        state.meshes.forEach((mesh, idx) => {
          const phase = idx * 0.7;
          qOffset.setFromAxisAngle(spinAxisY, Math.sin(t * 1.5 + phase) * 0.35);
          qTilt.setFromAxisAngle(spinAxisX, Math.cos(t * 1.2 + phase) * 0.22);
          mesh.quaternion.copy(baseQuats[idx]).premultiply(qOffset).premultiply(qTilt);
        });
        if (state.renderer) state.renderer.render(state.scene, state.camera);
        state.rafId = requestAnimationFrame(animatePreview);
      };

      if (state.renderer) state.renderer.render(state.scene, state.camera);
      if (typeof requestAnimationFrame === 'function') {
        state.rafId = requestAnimationFrame(animatePreview);
      }

      return () => {
        if (state.rafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(state.rafId);
          state.rafId = null;
        }
      };
    }

    // Mode 2: Settled roll moved into the tray -> each 3D die has its exact rolled number ON TOP (+Z)
    if (showSettled && settledRoll?.dice?.length) {
      const physical = expandPhysicalDice(settledRoll.dice);
      const { positions, scale } = layoutGridPositions(physical.length, halfW, halfH);

      physical.forEach((d, idx) => {
        const mesh = createDieMesh(d.variant);
        mesh.scale.setScalar(scale * (d.kept ? 1 : 0.84));
        const [x, y, z] = positions[idx];
        mesh.position.set(x, y, z);

        // Rotate so the rolled face normal points straight at the camera from (x, y, z)
        const faceUpQuat = quaternionForFaceUp(d.kind, d.targetValue);
        const toCam = new THREE.Vector3(
          -x,
          -y,
          state.camera.position.z - z,
        ).normalize();
        const aimQuat = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          toCam,
        );
        mesh.quaternion.copy(faceUpQuat).premultiply(aimQuat);

        state.scene.add(mesh);
        state.meshes.push(mesh);
      });

      if (state.renderer) {
        state.renderer.render(state.scene, state.camera);
      }
      return undefined;
    }

    // Mode 3: Empty well -> clear canvas, 0% GPU
    if (state.renderer) {
      state.renderer.clear();
    }
    return undefined;
  }, [hasSelection, selectedDice, showSettled, settledRoll]);

  return (
    <div
      ref={hostRef}
      className={`dice-well ${hasSelection ? 'has-selection' : ''} ${showSettled ? 'has-settled' : ''}`}
      aria-label="3D Dice Tray Well"
    >
      <canvas ref={canvasRef} className="dice-well-canvas" />

      {hasSelection && (
        <button
          type="button"
          className="dice-well-roll-btn"
          onClick={onRoll}
        >
          ROLL
        </button>
      )}

      {showSettled && (
        <div
          key={`${settledRoll.clientRollId}-${settledRoll.settledAt}`}
          className="dice-well-roll-btn is-result"
          role="status"
          aria-label={`Rolled total ${settledRoll.total}`}
        >
          {settledRoll.total}
        </div>
      )}
    </div>
  );
}
