import * as THREE from 'three';
import { createDieMesh, expandPhysicalDice } from './geometry/DiceMeshFactory.js';
import { DIE_RADIUS, FLOATS_PER_DIE, simulateThrow } from './physics/DiceSimulator.js';

const CAMERA_Z = 22;
const CAMERA_FOV = 38;
const SETTLE_HOLD_MS = 1200;
const FADE_OUT_MS = 1600;

/**
 * Computes world-space halfWidth and halfHeight visible at the floor plane (z = 0).
 * @param {number} widthPx
 * @param {number} heightPx
 */
export function computeFrustumBounds(widthPx, heightPx) {
  const aspect = widthPx > 0 && heightPx > 0 ? widthPx / heightPx : 16 / 9;
  const vFovRad = (CAMERA_FOV * Math.PI) / 180;
  const halfHeight = Math.max(4.5, Math.tan(vFovRad / 2) * CAMERA_Z * 0.92);
  const halfWidth = Math.max(4.5, halfHeight * aspect);
  return { halfWidth, halfHeight, aspect };
}

/**
 * Imperative Three.js + Cannon-es playback controller for the transparent dice overlay.
 *
 * Lifecycle:
 *   IDLE (0% GPU, no RAF loop)
 *     -> ROLLING (60/120Hz frame interpolation of pre-simulated trajectory)
 *     -> SETTLED (floating outcome badges over resting dice)
 *     -> FADING  (smooth ~700ms fade out from board while DiceTray pops in result)
 *     -> IDLE    (meshes removed, WebGL buffer cleared, RAF cancelled)
 */
export class DiceScene {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.width = canvas?.clientWidth || 960;
    this.height = canvas?.clientHeight || 640;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      this.width / Math.max(1, this.height),
      0.5,
      100,
    );
    this.camera.position.set(0, 0, CAMERA_Z);
    this.camera.lookAt(0, 0, 0);

    // Scrying Pool 3-point lighting
    const ambient = new THREE.AmbientLight(0xd8ecff, 1.35);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.85);
    keyLight.position.set(8, 12, 24);
    const rimLight = new THREE.DirectionalLight(0xadfcf9, 0.95);
    rimLight.position.set(-12, -10, 14);
    this.scene.add(ambient, keyLight, rimLight);

    this.renderer = null;
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setPixelRatio(
        typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1,
      );
      this.renderer.setSize(this.width, this.height, false);
    } catch {
      // Fallback for headless test environments without a WebGL context
      this.renderer = null;
    }

    /** @type {THREE.Mesh[]} */
    this.activeMeshes = [];
    this.rafId = null;
    this.activeRollToken = 0;
  }

  /**
   * Updates camera frustum and WebGL viewport when the board container resizes.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.renderer) {
      this.renderer.setSize(width, height, false);
      if (this.activeMeshes.length > 0) {
        this.renderer.render(this.scene, this.camera);
      }
    }
  }

  /** Removes any meshes from the previous roll and resets canvas to transparent. */
  clearActiveMeshes() {
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    for (const mesh of this.activeMeshes) {
      this.scene.remove(mesh);
    }
    this.activeMeshes = [];
    if (this.renderer) {
      this.renderer.clear();
    }
  }

  /**
   * Projects a 3D world coordinate to 2D pixel coordinates inside the overlay.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  projectToScreen(x, y, z) {
    const vec = new THREE.Vector3(x, y, z);
    vec.project(this.camera);
    return {
      x: (vec.x * 0.5 + 0.5) * this.width,
      y: (-vec.y * 0.5 + 0.5) * this.height,
    };
  }

  /**
   * Runs the full client-side 3D dice roll animation for `rollResult`.
   *
   * @param {import('../../../shared/dice/roller.js').RollResult} rollResult
   * @param {{
   *   onPhaseChange?: (phase: 'rolling' | 'settled' | 'fading' | 'idle') => void,
   *   onSettled?: (info: { roll: object, badges: object[] }) => void,
   *   onFadeStart?: (roll: object) => void,
   *   onComplete?: (roll: object) => void,
   * }} [callbacks]
   */
  playRoll(rollResult, callbacks = {}) {
    const token = ++this.activeRollToken;
    this.clearActiveMeshes();

    const physicalDice = expandPhysicalDice(rollResult.dice);
    if (physicalDice.length === 0) {
      callbacks.onPhaseChange?.('idle');
      callbacks.onComplete?.(rollResult);
      return;
    }

    const { halfWidth, halfHeight } = computeFrustumBounds(this.width, this.height);
    const sim = simulateThrow({
      dice: physicalDice.map((d) => ({ kind: d.kind, targetValue: d.targetValue })),
      halfWidth,
      halfHeight,
    });

    this.activeMeshes = physicalDice.map((d) => {
      const mesh = createDieMesh(d.variant);
      this.scene.add(mesh);
      return mesh;
    });

    const stride = sim.dieCount * FLOATS_PER_DIE;
    const totalSimMs = Math.max(1, (sim.frameCount - 1) * sim.stepDt * 1000);
    const posA = new THREE.Vector3();
    const posB = new THREE.Vector3();
    const quatA = new THREE.Quaternion();
    const quatB = new THREE.Quaternion();

    const applyFrame = (floatFrame) => {
      const idx0 = Math.min(sim.frameCount - 1, Math.max(0, Math.floor(floatFrame)));
      const idx1 = Math.min(sim.frameCount - 1, idx0 + 1);
      const alpha = floatFrame - idx0;

      for (let i = 0; i < sim.dieCount; i++) {
        const o0 = idx0 * stride + i * FLOATS_PER_DIE;
        const o1 = idx1 * stride + i * FLOATS_PER_DIE;
        posA.set(sim.frames[o0], sim.frames[o0 + 1], sim.frames[o0 + 2]);
        posB.set(sim.frames[o1], sim.frames[o1 + 1], sim.frames[o1 + 2]);
        quatA.set(sim.frames[o0 + 3], sim.frames[o0 + 4], sim.frames[o0 + 5], sim.frames[o0 + 6]);
        quatB.set(sim.frames[o1 + 3], sim.frames[o1 + 4], sim.frames[o1 + 5], sim.frames[o1 + 6]);

        const mesh = this.activeMeshes[i];
        mesh.position.lerpVectors(posA, posB, alpha);
        mesh.quaternion.slerpQuaternions(quatA, quatB, alpha);
      }
    };

    const buildSettledBadges = () => {
      const finalOffset = (sim.frameCount - 1) * stride;
      return physicalDice.map((d, i) => {
        const o = finalOffset + i * FLOATS_PER_DIE;
        const x = sim.frames[o];
        const y = sim.frames[o + 1];
        const z = sim.frames[o + 2] + DIE_RADIUS[d.kind] * 1.15;
        const screen = this.projectToScreen(x, y, z);
        return {
          key: `${i}-${d.variant}`,
          variant: d.variant,
          displayValue: d.displayValue,
          kept: d.kept,
          x: screen.x,
          y: screen.y,
        };
      });
    };

    callbacks.onPhaseChange?.('rolling');
    applyFrame(0);
    if (this.renderer) {
      this.renderer.render(this.scene, this.camera);
    }

    const startTime = performance.now();
    let settledFired = false;
    let fadeStarted = false;

    const tick = (now) => {
      if (token !== this.activeRollToken) return;
      const elapsed = now - startTime;

      if (elapsed < totalSimMs) {
        const floatFrame = (elapsed / totalSimMs) * (sim.frameCount - 1);
        applyFrame(floatFrame);
        if (this.renderer) this.renderer.render(this.scene, this.camera);
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      if (!settledFired) {
        settledFired = true;
        applyFrame(sim.frameCount - 1);
        if (this.renderer) this.renderer.render(this.scene, this.camera);
        callbacks.onPhaseChange?.('settled');
        callbacks.onSettled?.({
          roll: rollResult,
          badges: buildSettledBadges(),
        });
      }

      const afterSettleMs = elapsed - totalSimMs;
      if (afterSettleMs < SETTLE_HOLD_MS) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      if (!fadeStarted) {
        fadeStarted = true;
        callbacks.onPhaseChange?.('fading');
      }

      const fadeElapsed = afterSettleMs - SETTLE_HOLD_MS;
      if (fadeElapsed < FADE_OUT_MS) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      // Clean up meshes, pop the result into the Dice Tray, and suspend RAF (0% GPU when idle)
      this.clearActiveMeshes();
      callbacks.onFadeStart?.(rollResult);
      callbacks.onPhaseChange?.('idle');
      callbacks.onComplete?.(rollResult);
    };

    if (typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame(tick);
    } else {
      applyFrame(sim.frameCount - 1);
      callbacks.onPhaseChange?.('settled');
      callbacks.onSettled?.({ roll: rollResult, badges: buildSettledBadges() });
      callbacks.onFadeStart?.(rollResult);
      this.clearActiveMeshes();
      callbacks.onPhaseChange?.('idle');
      callbacks.onComplete?.(rollResult);
    }
  }

  dispose() {
    this.activeRollToken++;
    this.clearActiveMeshes();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
  }
}
