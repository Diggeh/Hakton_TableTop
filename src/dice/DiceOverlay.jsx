import { useEffect, useRef, useState } from 'react';
import { DiceScene } from './DiceScene.js';

/**
 * Transparent Three.js + Cannon-es overlay canvas positioned directly above the 2D board.
 *
 * - Never blocks pointer events (`pointer-events: none`), so players and the DM can
 *   pan, zoom, and drag Konva tokens even while dice are actively tumbling.
 * - Tumbles across the entire active board window, settles on the pre-determined faces,
 *   shows floating result badges + total banner, then smoothly fades out (~700ms) while
 *   popping the settled result into the Dice Tray.
 * - Suspends `requestAnimationFrame` completely when idle for 0% GPU/CPU usage.
 */
export default function DiceOverlay({
  width,
  height,
  activeRoll,
  onRollSettledIntoTray,
  onRollLifecycleEnd,
}) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const callbacksRef = useRef({ onRollSettledIntoTray, onRollLifecycleEnd });
  callbacksRef.current = { onRollSettledIntoTray, onRollLifecycleEnd };

  const [phase, setPhase] = useState('idle'); // 'idle' | 'rolling' | 'settled' | 'fading'
  const [settledInfo, setSettledInfo] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const scene = new DiceScene(canvas);
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (sceneRef.current && width > 0 && height > 0) {
      sceneRef.current.resize(width, height);
    }
  }, [width, height]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !activeRoll) return;

    setSettledInfo(null);
    scene.playRoll(activeRoll, {
      onPhaseChange: (nextPhase) => {
        setPhase(nextPhase);
      },
      onSettled: (info) => {
        setSettledInfo(info);
      },
      onFadeStart: (roll) => {
        // As the 3D dice begin fading from the board, pop the result into the Dice Tray
        callbacksRef.current.onRollSettledIntoTray?.(roll);
      },
      onComplete: (roll) => {
        setSettledInfo(null);
        callbacksRef.current.onRollLifecycleEnd?.(roll);
      },
    });
  }, [activeRoll]);

  const isVisible = phase !== 'idle';
  const isFading = phase === 'fading';
  const showBadges = (phase === 'settled' || phase === 'fading') && settledInfo;

  return (
    <div
      className={`dice-overlay ${isVisible ? 'is-active' : 'is-idle'} ${isFading ? 'is-fading' : ''}`}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="dice-overlay-canvas" />
      {showBadges && (
        <div className="dice-overlay-hud">
          {settledInfo.badges.map((b) => (
            <span
              key={b.key}
              className={`dice-floating-badge ${b.kept ? 'is-kept' : 'is-dropped'}`}
              style={{ left: `${b.x}px`, top: `${b.y}px` }}
            >
              <small>{b.variant}</small>
              <strong>{b.displayValue}</strong>
            </span>
          ))}
          <div className="dice-settled-banner" role="status" aria-live="polite">
            <span className="dice-settled-formula">
              {settledInfo.roll.label
                ? `${settledInfo.roll.label} (${settledInfo.roll.formula})`
                : settledInfo.roll.formula}
            </span>
            <strong className="dice-settled-total">{settledInfo.roll.total}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
