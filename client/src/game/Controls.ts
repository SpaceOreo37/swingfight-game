/**
 * Key bindings: defaults, the player's saved choices, and display names.
 * Codes are KeyboardEvent.code values ('KeyW', 'Space', 'ShiftLeft', ...)
 * or mouse buttons as 'Mouse0' (left), 'Mouse1' (middle), 'Mouse2' (right),
 * 'Mouse3' / 'Mouse4' (side buttons).
 */

/** Every rebindable action, in the order the settings list shows them. */
export const ACTIONS = {
  forward: { label: 'Move forward', keys: ['KeyW'] },
  back: { label: 'Move back', keys: ['KeyS'] },
  left: { label: 'Move left', keys: ['KeyA'] },
  right: { label: 'Move right', keys: ['KeyD'] },
  sprint: { label: 'Sprint', keys: ['ShiftLeft', 'ShiftRight'] },
  jump: { label: 'Jump', keys: ['Space'] },
  swing: { label: 'Web swing (hold, in the air)', keys: ['Mouse2'] },
  anchor: { label: 'Anchor (hold for launch / zip / strike)', keys: ['KeyC'] },
  thwip: { label: 'Thwip (10 m+ up)', keys: ['Tab'] },
  attack: { label: 'Web shot', keys: ['Mouse0'] },
  yank: { label: 'Yank', keys: ['KeyE'] },
  respawn: { label: 'Respawn', keys: ['BracketLeft'] },
  raceStart: { label: 'Race mode: start a race for everyone', keys: ['KeyG'] },
  view: { label: 'First / third person', keys: ['KeyV'] },
} as const satisfies Record<string, { label: string; keys: readonly string[] }>;

export type Action = keyof typeof ACTIONS;
export const ACTION_LIST = Object.keys(ACTIONS) as Action[];

const STORAGE_KEY = 'swingfight.keys';
/** Never bindable: Escape releases the mouse (the browser reserves it). */
export const RESERVED = new Set(['Escape']);

type Bindings = Record<Action, string[]>;

function defaults(): Bindings {
  const b = {} as Bindings;
  for (const a of ACTION_LIST) b[a] = [...ACTIONS[a].keys];
  return b;
}

function load(): Bindings {
  const b = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    // Respawn used to default to R (too close to E): move anyone still on the old default.
    if (Array.isArray(saved.respawn) && saved.respawn.length === 1 && saved.respawn[0] === 'KeyR') delete saved.respawn;
    for (const a of ACTION_LIST) {
      const v = saved[a];
      if (Array.isArray(v) && v.length && v.every((c) => typeof c === 'string' && c.length < 32 && !RESERVED.has(c))) b[a] = v as string[];
    }
  } catch {
    /* bad or blocked storage: defaults */
  }
  return b;
}

const current: Bindings = load();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn();
}

/** Keys/buttons currently bound to an action. */
export function binding(action: Action): readonly string[] {
  return current[action];
}

/**
 * Bind an action to one key. If another action already uses that key, the
 * two swap, so nothing ever ends up bound twice or left unbound.
 */
export function setBinding(action: Action, code: string): void {
  if (RESERVED.has(code)) return;
  const previous = current[action];
  for (const other of ACTION_LIST) {
    if (other !== action && current[other].includes(code)) {
      const rest = current[other].filter((c) => c !== code);
      current[other] = rest.length ? rest : [...previous];
    }
  }
  current[action] = [code];
  persist();
}

export function resetBindings(): void {
  Object.assign(current, defaults());
  persist();
}

export function isBound(code: string): boolean {
  return ACTION_LIST.some((a) => current[a].includes(code));
}

/** Get told when bindings change (to refresh labels). Returns an unsubscribe function. */
export function onBindingsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const NAMES: Record<string, string> = {
  Mouse0: 'Left click',
  Mouse1: 'Middle click',
  Mouse2: 'Right click',
  Mouse3: 'Mouse 4',
  Mouse4: 'Mouse 5',
  Space: 'Space',
  ShiftLeft: 'Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'Alt',
  AltRight: 'R Alt',
  MetaLeft: 'Cmd',
  MetaRight: 'R Cmd',
  CapsLock: 'Caps',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Backspace: 'Backspace',
};

/** Short, readable name for a key code ("KeyW" -> "W", "Mouse2" -> "Right click"). */
export function keyName(code: string): string {
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** Display name for an action's binding (first key if several, e.g. both Shifts). */
export function bindingName(action: Action): string {
  return keyName(current[action][0]);
}
