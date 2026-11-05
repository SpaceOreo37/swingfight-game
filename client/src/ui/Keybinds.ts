import { ACTIONS, ACTION_LIST, RESERVED, bindingName, onBindingsChanged, resetBindings, setBinding, type Action } from '../game/Controls';

/**
 * The key-binding editor on the home / pause screen, plus the one-line
 * hint bar shown in game. Click a key, press a new key or mouse button,
 * done (Esc cancels). Combos and hints always show your current keys.
 */
export class Keybinds {
  private stopCapture: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly hint: HTMLElement,
  ) {
    onBindingsChanged(() => this.render());
    this.render();
  }

  private render(): void {
    this.root.replaceChildren();
    for (const action of ACTION_LIST) {
      const row = document.createElement('div');
      row.className = 'bind-row';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'keybtn';
      btn.textContent = bindingName(action);
      btn.title = 'Click, then press a key or mouse button';
      btn.addEventListener('click', () => this.capture(action, btn));
      const label = document.createElement('span');
      label.textContent = ACTIONS[action].label;
      row.append(btn, label);
      this.root.append(row);
    }

    // Combos (not keys of their own): always shown with the current keys.
    const k = (a: Action) => `<kbd>${escapeHtml(bindingName(a))}</kbd>`;
    const combos: [string, string][] = [
      [`${k('anchor')} + ${k('swing')}`, 'Zip to the marker (ground or air) · Space mid-zip = launch / bounce'],
      [`${k('anchor')} + ${k('attack')}`, 'Zip strike · on a yanked player: fatal slam'],
      ['<kbd>Walls</kbd>', 'Run into one to stick · push in to climb · Jump to wall-jump'],
      ['<kbd>Fly into</kbd>', 'Swing kick (faster = harder)'],
      ['<kbd>Esc</kbd>', 'Pause / this menu'],
    ];
    for (const [keys, text] of combos) {
      const row = document.createElement('div');
      row.className = 'bind-row combo';
      const left = document.createElement('span');
      left.className = 'k';
      left.innerHTML = keys;
      const right = document.createElement('span');
      right.textContent = text;
      row.append(left, right);
      this.root.append(row);
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset-binds';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => resetBindings());
    this.root.append(reset);

    const n = (a: Action) => bindingName(a);
    this.hint.textContent =
      `${n('forward')}${n('left')}${n('back')}${n('right')} move · ${n('sprint')} sprint · ${n('jump')} jump · ` +
      `${n('swing')} swing · ${n('attack')} shoot · ${n('yank')} yank · ${n('anchor')}+${n('attack')} zip strike · ` +
      `${n('anchor')}+${n('swing')} zip · ${n('thwip')} thwip · ${n('view')} camera · ${n('respawn')} respawn · Esc menu`;
  }

  /** Wait for the next key or mouse button and bind it. */
  private capture(action: Action, button: HTMLButtonElement): void {
    this.stopCapture?.();
    button.textContent = 'Press a key…';
    button.classList.add('listening');

    const finish = (code: string | null) => {
      cleanup();
      if (code) setBinding(action, code);
      else this.render(); // cancelled: restore the label
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't let Enter start the game, etc.
      finish(e.code === 'Escape' || RESERVED.has(e.code) ? null : e.code);
    };
    const onMouse = (e: MouseEvent) => {
      // Clicking another key button means "change that one instead".
      if (e.button === 0 && e.target instanceof HTMLElement && e.target.closest('.keybtn, .reset-binds')) {
        finish(null);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      finish(`Mouse${e.button}`);
    };
    const noMenu = (e: Event) => e.preventDefault();
    const cleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('contextmenu', noMenu, true);
      this.stopCapture = null;
    };
    this.stopCapture = () => {
      cleanup();
      this.render();
    };
    // Listen right away: the click that got us here has already finished
    // (mousedown came before it), so it can't be captured by mistake.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('contextmenu', noMenu, true);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
