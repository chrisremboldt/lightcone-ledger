import { appFetch } from '../transport.js';
import { usable, type Locator } from './locators.js';

/**
 * Autopilot: a simulated person who uses the real screens. It moves a visible cursor, clicks and
 * types through the same controls a person would, and says what it is doing. It sends nothing
 * itself; every request is the application's own, made because a control was used.
 */

export type Status = 'idle' | 'running' | 'paused' | 'done' | 'failed';

export interface AutopilotState {
  status: Status;
  scene: { id: string; title: string } | null;
  /** Who is acting, for example "Avery Chen · Safety manager". */
  actor: string;
  caption: string;
  cursor: { x: number; y: number; visible: boolean; pressed: boolean; travelMs: number };
  problem: string | null;
}

export interface Scene {
  id: string;
  /** The organization the scene happens in, as keyed on the sign-in screen. */
  operator: 'alpha' | 'beta' | 'utility';
  title: string;
  /** What the scene shows, which groups it with others on the sign-in screen. */
  shows: string;
  /** One line for the sign-in screen: what a visitor is about to watch. */
  summary: string;
  run(actor: Actor): Promise<void>;
}

const idle: AutopilotState = {
  status: 'idle',
  scene: null,
  actor: '',
  caption: '',
  cursor: { x: 0, y: 0, visible: false, pressed: false, travelMs: 0 },
  problem: null,
};

let state = idle;
const listeners = new Set<() => void>();

function update(change: Partial<AutopilotState>): void {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const snapshot = (): AutopilotState => state;

class Stopped extends Error {}

interface Run {
  abort: AbortController;
  paused: boolean;
  resume: Array<() => void>;
}

let current: Run | null = null;

const FIND_TIMEOUT_MS = 20_000;
const POLL_MS = 100;

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  // React tracks the value it last rendered; the native setter is what a real keystroke uses.
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
}

/** A position inside an element's box: 0 is its left or top edge, 1 its right or bottom edge. */
export interface Fraction {
  x: number;
  y: number;
}

/** A click goes to the nearest element containing both where the button went down and where it came up. */
function commonAncestor(pressed: Element, released: Element): Element {
  let candidate: Element | null = pressed;
  while (candidate && !candidate.contains(released)) candidate = candidate.parentElement;
  return candidate ?? document.documentElement;
}

function clickEvent(target: Element, x: number, y: number): void {
  target.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      detail: 1,
    }),
  );
}

export class Actor {
  constructor(
    private readonly run: Run,
    /** Multiplies every deliberate delay. 1 is a person's pace; near 0 is as fast as the page allows. */
    private readonly pace: number,
  ) {}

  private check(): void {
    if (this.run.abort.signal.aborted) throw new Stopped();
  }

  private async wait(ms: number): Promise<void> {
    this.check();
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    while (this.run.paused) await new Promise<void>((resolve) => this.run.resume.push(resolve));
    this.check();
  }

  /** A deliberate, human-scale delay. */
  rest(ms: number): Promise<void> {
    return this.wait(ms * this.pace);
  }

  /** Say what is happening, and leave time to read it. */
  async say(caption: string, actor?: string): Promise<void> {
    update({ caption, ...(actor ? { actor } : {}) });
    await this.rest(Math.max(1400, caption.length * 42));
  }

  private async find(locator: Locator, timeoutMs?: number): Promise<HTMLElement> {
    return (await this.locate(locator, timeoutMs, (element) => element instanceof HTMLElement)) as HTMLElement;
  }

  private async locate(
    locator: Locator,
    timeoutMs = FIND_TIMEOUT_MS,
    accept = (element: Element) => element instanceof HTMLElement || element instanceof SVGElement,
  ): Promise<Element> {
    // A replay sets the page's clock to the recording's, which can jump; waiting uses real elapsed time.
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const element = locator.element();
      if (element && accept(element) && usable(element)) return element;
      if (performance.now() > deadline) throw new Error(`Could not find ${locator.description}`);
      await this.wait(POLL_MS);
    }
  }

  private async reveal(element: Element): Promise<DOMRect> {
    const before = element.getBoundingClientRect();
    if (before.top < 80 || before.bottom > window.innerHeight - 140) {
      element.scrollIntoView({ block: 'center', behavior: this.pace > 0.3 ? 'smooth' : 'auto' });
      await this.rest(450);
    }
    return element.getBoundingClientRect();
  }

  private async travel(x: number, y: number, pressed = false): Promise<void> {
    const from = state.cursor.visible ? state.cursor : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const travelMs = Math.min(900, Math.max(220, Math.hypot(x - from.x, y - from.y) * 0.9)) * this.pace;
    update({ cursor: { x, y, visible: true, pressed, travelMs } });
    await this.wait(travelMs);
  }

  private async pointAt(element: Element, where: 'center' | 'start' = 'center'): Promise<void> {
    const box = await this.reveal(element);
    const x = where === 'start' ? box.left + Math.min(28, box.width / 2) : box.left + box.width / 2;
    await this.travel(x, box.top + box.height / 2);
    await this.rest(120);
  }

  /** Where a fraction of an element's box is on screen, once the element is in view. */
  private async box(locator: Locator): Promise<(at: Fraction) => { x: number; y: number }> {
    const box = await this.reveal(await this.locate(locator));
    return (at) => ({ x: box.left + box.width * at.x, y: box.top + box.height * at.y });
  }

  /**
   * The element a real pointer at this point would reach: the topmost one there, which need not be
   * the located element. The simulated session's own bar is never a target.
   */
  private under(x: number, y: number): Element {
    const target = document.elementFromPoint(x, y);
    if (!target || target.closest('[data-testid="autopilot"]'))
      throw new Error(`Nothing on the page is under the point at (${Math.round(x)}, ${Math.round(y)})`);
    return target;
  }

  /**
   * One step of a mouse, as a browser reports it: the pointer event first, then its mouse
   * counterpart unless the pointer-down was cancelled. Returns whether the pointer event was cancelled.
   */
  private pointer(
    kind: 'move' | 'down' | 'up',
    target: Element,
    x: number,
    y: number,
    held: boolean,
    mouse = true,
  ): boolean {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      button: kind === 'move' ? -1 : 0,
      buttons: held ? 1 : 0,
      detail: kind === 'move' ? 0 : 1,
    };
    const cancelled = !target.dispatchEvent(
      new PointerEvent(`pointer${kind}`, {
        ...init,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        width: 1,
        height: 1,
        pressure: held ? 0.5 : 0,
      }),
    );
    if (mouse) target.dispatchEvent(new MouseEvent(`mouse${kind}`, { ...init, button: Math.max(0, init.button) }));
    return cancelled;
  }

  /** A real press focuses the nearest focusable element under the pointer, as the browser would. */
  private focusUnder(target: Element): void {
    const focusable = target.closest<HTMLElement | SVGElement>(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus({ preventScroll: true });
  }

  /** Press the button at one point, move through the others holding it, and release at the last. */
  private async gesture(start: { x: number; y: number }, path: { x: number; y: number }[]): Promise<void> {
    await this.travel(start.x, start.y);
    await this.rest(120);
    const target = this.under(start.x, start.y);
    this.pointer('move', target, start.x, start.y, false);
    update({ cursor: { ...state.cursor, pressed: true } });
    const cancelled = this.pointer('down', target, start.x, start.y, true);
    this.focusUnder(target);
    await this.rest(130);
    for (const at of path) {
      update({ cursor: { ...state.cursor, x: at.x, y: at.y, pressed: true, travelMs: 40 * this.pace } });
      this.pointer('move', this.under(at.x, at.y), at.x, at.y, true, !cancelled);
      await this.rest(40);
    }
    const end = path.at(-1) ?? start;
    const released = this.under(end.x, end.y);
    this.pointer('up', released, end.x, end.y, false, !cancelled);
    update({ cursor: { ...state.cursor, pressed: false } });
    clickEvent(commonAncestor(target, released), end.x, end.y);
    await this.rest(350);
  }

  /**
   * Click at a point inside an element, given as fractions of its box: `{ x: 0.6, y: 0.55 }` is
   * 60% across and 55% down. The events go to whatever is on top at that point, with its
   * coordinates, as a real mouse click would. Use `click` for ordinary controls.
   */
  async clickAt(locator: Locator, at: Fraction): Promise<void> {
    const point = await this.box(locator);
    await this.gesture(point(at), []);
  }

  /**
   * Press at one point of an element and drag to another, both as fractions of the element's box
   * when the press begins; fractions outside 0–1 reach beyond it.
   */
  async drag(locator: Locator, from: Fraction, to: Fraction): Promise<void> {
    const point = await this.box(locator);
    const start = point(from);
    const steps = 12;
    await this.gesture(
      start,
      Array.from({ length: steps }, (_, index) =>
        point({
          x: from.x + ((to.x - from.x) * (index + 1)) / steps,
          y: from.y + ((to.y - from.y) * (index + 1)) / steps,
        }),
      ),
    );
  }

  private async press(): Promise<void> {
    update({ cursor: { ...state.cursor, pressed: true } });
    await this.rest(130);
    update({ cursor: { ...state.cursor, pressed: false } });
  }

  /**
   * Find what a locator names and point at it. The page can render again while the pointer travels and put a new
   * node in the target's place; a node that has left the page ignores a click or a keystroke, so the target is found
   * and pointed at again until the node the pointer arrives on is still part of the page.
   */
  private async aim(locator: Locator, where: 'center' | 'start' = 'center'): Promise<HTMLElement> {
    for (;;) {
      const element = await this.find(locator);
      await this.pointAt(element, where);
      if (element.isConnected) return element;
    }
  }

  /** Wait until something is no longer on screen, such as a note that work is still in progress. */
  async gone(locator: Locator, timeoutMs = FIND_TIMEOUT_MS): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (locator.element()) {
      if (performance.now() > deadline) throw new Error(`${locator.description} is still on screen`);
      await this.wait(POLL_MS);
    }
  }

  /** Wait until something is on screen, and point at it. */
  async see(locator: Locator, timeoutMs?: number): Promise<void> {
    await this.pointAt(await this.locate(locator, timeoutMs));
    await this.rest(500);
  }

  async click(locator: Locator): Promise<void> {
    const element = await this.aim(locator);
    await this.press();
    element.click();
    await this.rest(350);
  }

  /** Tick a checkbox or choose a radio button. */
  async tick(locator: Locator): Promise<void> {
    const element = (await this.aim(locator)) as HTMLInputElement;
    await this.press();
    if (!element.checked) element.click();
    await this.rest(300);
  }

  async type(locator: Locator, text: string): Promise<void> {
    const element = (await this.aim(locator, 'start')) as HTMLInputElement | HTMLTextAreaElement;
    await this.press();
    element.focus();
    for (let length = 1; length <= text.length; length++) {
      setValue(element, text.slice(0, length));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await this.rest(text[length - 1] === ' ' ? 55 : 24 + Math.random() * 26);
    }
    await this.rest(250);
  }

  /** Pick a file for a file field, as a person choosing one from their computer would. */
  async attach(locator: Locator, file: { name: string; type: string; text: string }): Promise<void> {
    const element = (await this.aim(locator)) as HTMLInputElement;
    await this.press();
    const chosen = new DataTransfer();
    chosen.items.add(new File([file.text], file.name, { type: file.type }));
    element.files = chosen.files;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await this.rest(450);
  }

  /**
   * Something happens outside the person's screen: a source system reports to Ledger. It goes
   * through the public API like any other source, and a recording keeps it with the scene.
   */
  async happen<T>(
    token: string,
    path: string,
    body?: unknown,
    options: { method?: 'POST' | 'PUT'; bytes?: Uint8Array } = {},
  ): Promise<T> {
    this.check();
    const response = await appFetch(path, {
      method: options.method ?? 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.bytes
          ? { 'content-type': 'application/octet-stream' }
          : body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        'idempotency-key': crypto.randomUUID(),
      },
      body: options.bytes
        ? new Blob([options.bytes as BlobPart])
        : body === undefined
          ? undefined
          : JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(
        `A source report to ${path} was refused (${response.status}): ${(await response.text()).slice(0, 200)}`,
      );
    return (response.headers.get('content-type')?.includes('json') ? await response.json() : undefined) as T;
  }

  /** Read something through the public API as a source or an administrator would. */
  async ask<T>(token: string, path: string): Promise<T> {
    this.check();
    const response = await appFetch(path, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`A read was refused (${response.status})`);
    return (await response.json()) as T;
  }

  /** Pick an option in a select by its value. */
  async choose(locator: Locator, value: string): Promise<void> {
    const element = (await this.find(locator)) as HTMLSelectElement;
    // A select can be on screen before its options have been read.
    const deadline = performance.now() + FIND_TIMEOUT_MS;
    while (![...element.options].some((option) => option.value === value)) {
      if (performance.now() > deadline) throw new Error(`${locator.description} has no option “${value}”`);
      await this.wait(POLL_MS);
    }
    await this.pointAt(element);
    await this.press();
    element.focus();
    setValue(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await this.rest(450);
  }
}

export function stop(): void {
  if (!current) return;
  current.abort.abort();
  for (const resume of current.resume.splice(0)) resume();
  current = null;
  update(idle);
}

export function pause(): void {
  if (!current || state.status !== 'running') return;
  current.paused = true;
  update({ status: 'paused' });
}

export function resume(): void {
  if (!current || state.status !== 'paused') return;
  current.paused = false;
  for (const wake of current.resume.splice(0)) wake();
  update({ status: 'running' });
}

export async function play(scene: Scene, pace = 1): Promise<void> {
  stop();
  const run: Run = { abort: new AbortController(), paused: false, resume: [] };
  current = run;
  update({ ...idle, status: 'running', scene: { id: scene.id, title: scene.title } });
  try {
    await scene.run(new Actor(run, pace));
    if (current === run) update({ status: 'done', cursor: { ...state.cursor, visible: false } });
  } catch (error) {
    if (error instanceof Stopped || current !== run) return;
    update({
      status: 'failed',
      problem: error instanceof Error ? error.message : String(error),
      cursor: { ...state.cursor, visible: false },
    });
  }
}
