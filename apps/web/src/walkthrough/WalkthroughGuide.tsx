import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { steps, type Copy } from './script.js';
import '../styles/walkthrough.css';

const STEP_KEY = 'ledger.walkthrough.card.step';
const SPOT_KEY = 'ledger.walkthrough.card.spot';
const OPEN_KEY = 'ledger.walkthrough.card.open';

function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : (JSON.parse(stored) as T);
  });
  return [
    value,
    (next: T) => {
      localStorage.setItem(key, JSON.stringify(next));
      setValue(next);
    },
  ];
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input, textarea, select')));

/** A modal dialog makes everything outside it inert, so the card moves inside while one is open. */
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

function CopyRow({ item }: { item: Copy }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="wt-copy">
      <span className="wt-copy-label">{item.label}</span>
      <code>{item.value}</code>
      <button
        type="button"
        className={copied ? 'is-copied' : undefined}
        onClick={() => {
          void navigator.clipboard.writeText(item.value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </li>
  );
}

export default function WalkthroughGuide() {
  const [stored, setIndex] = useStored(STEP_KEY, 0);
  const [spot, setSpot] = useStored(SPOT_KEY, { x: 16, y: 16 });
  const [open, setOpen] = useStored(OPEN_KEY, true);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const host = useHost();
  const index = Math.min(Math.max(stored, 0), steps.length - 1);
  const step = steps[index]!;
  const go = (next: number) => setIndex(Math.min(Math.max(next, 0), steps.length - 1));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowRight') go(index + 1);
      if (event.key === 'ArrowLeft') go(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    drag.current = { dx: event.clientX - spot.x, dy: window.innerHeight - event.clientY - spot.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    setSpot({
      x: Math.max(0, Math.min(event.clientX - drag.current.dx, window.innerWidth - 120)),
      y: Math.max(0, Math.min(window.innerHeight - event.clientY - drag.current.dy, window.innerHeight - 40)),
    });
  };
  const endDrag = () => {
    drag.current = null;
  };

  return createPortal(
    <aside className="wt-card" style={{ left: spot.x, bottom: spot.y }} aria-label="Walkthrough">
      <header
        className="wt-bar"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <button type="button" className="wt-arrow" onClick={() => go(index - 1)} disabled={index === 0}>
          ←
        </button>
        <span className="wt-count">
          {index + 1} / {steps.length}
        </span>
        <button type="button" className="wt-arrow" onClick={() => go(index + 1)} disabled={index === steps.length - 1}>
          →
        </button>
        <span className="wt-grip" title="Drag to move" />
        <button type="button" className="wt-arrow" title={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>
          {open ? '–' : '+'}
        </button>
      </header>
      <div className="wt-main">
        <strong className="wt-title">{step.title}</strong>
        {open && (
          <>
            <span className="wt-as">As {step.as}</span>
            <p className="wt-text">{step.text}</p>
            {step.copy && (
              <ul className="wt-copies">
                {step.copy.map((item) => (
                  <CopyRow key={`${index}-${item.label}`} item={item} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </aside>,
    host,
  );
}
