import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { mode } from '../transport.js';
import { pause, resume, snapshot, stop, subscribe } from './player.js';
import { sceneById } from './scenes.js';
import { begin } from './session.js';
import '../styles/autopilot.css';

/** A modal dialog makes everything outside it inert, so the layer moves inside while one is open. */
function useHost(): HTMLElement {
  const [host, setHost] = useState<HTMLElement>(document.body);
  useEffect(() => {
    const timer = setInterval(() => {
      setHost(document.querySelector<HTMLDialogElement>('dialog:modal') ?? document.body);
    }, 300);
    return () => clearInterval(timer);
  }, []);
  return host;
}

const paces: Record<string, number> = { fast: 0.05, slow: 1.5 };

/** `?autopilot=<scene>` starts a scene on load; `&pace=fast` runs it as fast as the page allows. */
function requested(): { scene: string; pace: number } | null {
  const query = new URLSearchParams(window.location.search);
  const scene = query.get('autopilot');
  return scene ? { scene, pace: paces[query.get('pace') ?? ''] ?? 1 } : null;
}

let autostarted = false;

export default function AutopilotLayer() {
  const state = useSyncExternalStore(subscribe, snapshot);
  const host = useHost();

  useEffect(() => {
    // Development renders effects twice; a scene asked for by the address starts once.
    if (autostarted) return;
    autostarted = true;
    const request = requested();
    const scene = request && sceneById(request.scene);
    if (scene) void begin(scene, request.pace);
  }, []);

  if (state.status === 'idle' || !state.scene) return null;
  const scene = sceneById(state.scene.id);
  const ended = state.status === 'done' || state.status === 'failed';

  return createPortal(
    <>
      {state.cursor.visible && (
        <div
          className={`ap-cursor${state.cursor.pressed ? ' is-pressed' : ''}`}
          style={{
            transform: `translate(${state.cursor.x}px, ${state.cursor.y}px)`,
            transitionDuration: `${state.cursor.travelMs}ms`,
          }}
          aria-hidden="true"
        >
          <span className="ap-ring" />
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M4 2l15 9.5-6.6 1.4 4 7.6-2.9 1.5-4-7.7L4 19z" />
          </svg>
        </div>
      )}
      <aside className="ap-bar" aria-label="Simulated session" data-testid="autopilot" data-status={state.status}>
        <div className="ap-who">
          <span className="ap-pill">
            <i className="pulse" />
            {mode() === 'replay' ? 'Simulated person · recorded' : 'Simulated person'}
          </span>
          {state.actor && <strong>{state.actor}</strong>}
        </div>
        <p className="ap-caption" role="status">
          {state.status === 'failed'
            ? `The simulated session stopped: ${state.problem}.`
            : state.status === 'done'
              ? `Scene complete: ${state.scene.title}.`
              : state.caption}
        </p>
        <div className="ap-controls">
          {state.status === 'running' && (
            <button type="button" onClick={pause}>
              Pause
            </button>
          )}
          {state.status === 'paused' && (
            <button type="button" onClick={resume}>
              Resume
            </button>
          )}
          {ended && scene && (
            <button type="button" onClick={() => void begin(scene)}>
              Play again
            </button>
          )}
          <button type="button" onClick={stop}>
            {ended ? 'Close' : 'Take over'}
          </button>
        </div>
      </aside>
    </>,
    host,
  );
}

/** Start a scene from the page itself, for example from a button on the sign-in screen. */
export function start(sceneId: string): void {
  const scene = sceneById(sceneId);
  if (scene) void begin(scene);
}
