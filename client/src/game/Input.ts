import { BINDINGS, type Action } from './Controls';

/**
 * Keyboard + mouse state. "Pressed" events are latched until something
 * consumes them, so a quick tap is never lost between physics steps.
 */
export class Input {
  private readonly held = new Set<string>();
  private readonly latched = new Set<string>();
  private dx = 0;
  private dy = 0;
  private moveEvents = 0;
  private moveEventsWindowStart = performance.now();
  private lastEventsPerSecond = 0;
  locked = false;
  /** Ask the browser for raw (unaccelerated) mouse movement. Toggle in the menu. */
  rawMouse = true;
  /** Called when the browser refuses to capture the mouse (e.g. clicked too soon after Esc). */
  onLockFailed: (() => void) | null = null;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return; // typing a name
      if (!e.repeat) this.latched.add(e.code);
      this.held.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault(); // no page scroll / focus jumping
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());

    target.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      const code = `Mouse${e.button}`;
      this.held.add(code);
      this.latched.add(code);
    });
    window.addEventListener('mouseup', (e) => this.held.delete(`Mouse${e.button}`));
    target.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Some browsers occasionally report one huge bogus jump; ignore those.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
      this.moveEvents++;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.held.clear();
    });
  }

  /**
   * Captures the mouse. Asks for raw (unaccelerated) movement where supported,
   * which makes aiming feel much snappier and more consistent.
   */
  requestLock(): void {
    const el = this.target as HTMLElement & {
      requestPointerLock(opts?: { unadjustedMovement?: boolean }): Promise<void> | void;
    };
    const fallback = () => {
      try {
        const p = el.requestPointerLock();
        if (p instanceof Promise) p.catch(() => this.onLockFailed?.());
      } catch {
        this.onLockFailed?.();
      }
    };
    if (!this.rawMouse) return fallback();
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p instanceof Promise) p.catch(fallback);
    } catch {
      fallback();
    }
  }

  /** Mouse movement events per second (diagnostic: should be 60+ while moving the mouse). */
  eventsPerSecond(): number {
    const now = performance.now();
    if (now - this.moveEventsWindowStart >= 1000) {
      this.lastEventsPerSecond = Math.round((this.moveEvents * 1000) / (now - this.moveEventsWindowStart));
      this.moveEvents = 0;
      this.moveEventsWindowStart = now;
    }
    return this.lastEventsPerSecond;
  }

  /** True while any key bound to the action is held. */
  down(action: Action): boolean {
    return BINDINGS[action].some((c) => this.held.has(c));
  }

  /** True once per press of the action. */
  consume(action: Action): boolean {
    let hit = false;
    for (const c of BINDINGS[action]) if (this.latched.delete(c)) hit = true;
    return hit;
  }

  /** Mouse movement since the last call. */
  takeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return d;
  }
}
