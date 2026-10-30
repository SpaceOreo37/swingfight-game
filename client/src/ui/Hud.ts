import { Keybinds } from './Keybinds';
import type { GameMode } from '@game/shared';
import { LAUNCH, launchPower } from '@game/shared';

const NAME_KEY = 'swingfight.name';
const SENS_KEY = 'swingfight.sensitivity';
const QUALITY_KEY = 'swingfight.quality';
const RAW_KEY = 'swingfight.rawMouse';
const VIEW_KEY = 'swingfight.view';
const ROOM_KEY = 'swingfight.room';
const MODE_KEY = 'swingfight.mode';

export type Quality = 'high' | 'medium' | 'low';
export type View = 'third' | 'first';

export interface Settings {
  name: string;
  sensitivity: number;
  quality: Quality;
  rawMouse: boolean;
  view: View;
  room: string;
  mode: GameMode;
}

/** Seconds of charge that fill the whole meter. */
const CHARGE_SCALE = 5;

/** Storage can throw (private mode, blocked cookies), so every access is guarded. */
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** A group of radio buttons (mode cards, segmented toggles) read/written by value. */
class RadioGroup<T extends string> {
  constructor(private readonly name: string) {}
  get value(): T {
    return (document.querySelector<HTMLInputElement>(`input[name="${this.name}"]:checked`)?.value ?? '') as T;
  }
  set value(v: T) {
    const el = document.querySelector<HTMLInputElement>(`input[name="${this.name}"][value="${v}"]`);
    if (el) el.checked = true;
  }
}

/** Home screen (doubles as the pause menu) and the in-game overlay. */
export class Hud {
  private readonly stats = document.getElementById('stats')!;
  private readonly overlay = document.getElementById('overlay')!;
  private readonly notice = document.getElementById('notice')!;
  private readonly nameInput = document.getElementById('name-input') as HTMLInputElement;
  private readonly sensInput = document.getElementById('sens-input') as HTMLInputElement;
  private readonly sensValue = document.getElementById('sens-value')!;
  private readonly qualityInput = new RadioGroup<Quality>('quality');
  private readonly rawInput = document.getElementById('raw-input') as HTMLInputElement;
  private readonly viewInput = new RadioGroup<View>('view');
  private readonly roomInput = document.getElementById('room-input') as HTMLInputElement;
  private readonly modeInput = new RadioGroup<GameMode>('mode');
  private readonly inviteBtn = document.getElementById('invite-btn') as HTMLButtonElement;
  private readonly kicker = document.getElementById('home-kicker')!;
  private readonly serverStatus = document.getElementById('server-status')!;
  private readonly serverStatusText = document.getElementById('server-status-text')!;
  private entered = false;
  private readonly playBtn = document.getElementById('play-btn') as HTMLButtonElement;
  private readonly nameLabel = document.getElementById('player-name')!;
  readonly minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
  private last = '';
  private readonly charge = document.getElementById('charge')!;
  private readonly chargeFill = document.getElementById('charge-fill')!;
  private readonly chargeLabel = document.getElementById('charge-label')!;
  private chargeShown = false;
  private readonly launchCue = document.getElementById('launch-cue')!;
  private launchCueText: string | null = null;

  constructor() {
    const zone = (id: string, from: number, to: number) => {
      const el = document.getElementById(id)!;
      el.style.left = `${(from / CHARGE_SCALE) * 100}%`;
      el.style.width = `${((to - from) / CHARGE_SCALE) * 100}%`;
    };
    zone('charge-zone-ramp', LAUNCH.rampStart, LAUNCH.fullAt);
    zone('charge-zone-max', LAUNCH.fullAt, LAUNCH.overchargeAt);
    zone('charge-zone-over', LAUNCH.overchargeAt, CHARGE_SCALE);
    this.nameInput.value = load(NAME_KEY) ?? '';
    this.sensInput.value = load(SENS_KEY) ?? '1';
    this.sensValue.textContent = Number(this.sensInput.value).toFixed(1);
    this.sensInput.addEventListener('input', () => {
      this.sensValue.textContent = Number(this.sensInput.value).toFixed(1);
    });
    const q = load(QUALITY_KEY);
    this.qualityInput.value = q === 'medium' || q === 'low' ? q : 'high';
    this.rawInput.checked = load(RAW_KEY) !== 'false';
    this.viewInput.value = load(VIEW_KEY) === 'first' ? 'first' : 'third';
    const mode = new URLSearchParams(location.search).get('mode') ?? load(MODE_KEY);
    this.modeInput.value = mode === 'training' || mode === 'tag' ? mode : 'brawl';
    // A ?room=xyz link pre-fills the room, so you can send friends a direct link.
    this.roomInput.value = new URLSearchParams(location.search).get('room') ?? load(ROOM_KEY) ?? '';

    this.inviteBtn.addEventListener('click', () => this.copyInvite());
    new Keybinds(document.getElementById('keybinds')!, document.getElementById('controls')!);
    document.body.classList.add('at-home');
    this.pollServer();
  }

  /** Copy a link that opens this room and mode. Makes up a private room name if none. */
  private async copyInvite(): Promise<void> {
    if (!this.roomInput.value.trim()) this.roomInput.value = `crew-${Math.floor(Math.random() * 9000 + 1000)}`;
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(this.roomInput.value.trim())}&mode=${this.modeInput.value}`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      window.prompt('Copy this link and send it to your friends:', url);
    }
    this.inviteBtn.textContent = ok ? 'Copied!' : 'Copy invite';
    setTimeout(() => (this.inviteBtn.textContent = 'Copy invite'), 1600);
  }

  /** "Server online · N playing" while the menu is open. */
  private pollServer(): void {
    const check = async () => {
      try {
        const res = await fetch('/health', { cache: 'no-store' });
        if (!res.ok) throw new Error();
        const h = (await res.json()) as { players?: number };
        const n = h.players ?? 0;
        this.serverStatus.className = 'server-status online';
        this.serverStatusText.textContent = `Server online · ${n} ${n === 1 ? 'player' : 'players'} in game`;
      } catch {
        this.serverStatus.className = 'server-status offline';
        this.serverStatusText.textContent = 'Server offline · you can still swing around solo';
      }
    };
    check();
    setInterval(() => {
      if (!this.overlay.classList.contains('hidden')) check();
    }, 5000);
  }

  /** Name (as the server made it unique) and room, under the minimap. */
  setPlayerLabel(name: string, room: string): void {
    this.nameLabel.textContent = room === 'main' ? name : `${name} · ${room}`;
  }

  /** Keep the menu in sync when the view is switched in-game (V). */
  setView(view: View): void {
    this.viewInput.value = view;
    save(VIEW_KEY, view);
  }

  get view(): View {
    return this.viewInput.value as View;
  }

  get quality(): Quality {
    return this.qualityInput.value as Quality;
  }

  /** Fires when the player clicks Play (or presses Enter in the name box). */
  onPlay(fn: (settings: Settings) => void): void {
    const start = () => {
      const name = this.nameInput.value.trim().slice(0, 16) || `Player${Math.floor(Math.random() * 9000 + 1000)}`;
      this.nameInput.value = name;
      save(NAME_KEY, name);
      save(SENS_KEY, this.sensInput.value);
      save(QUALITY_KEY, this.qualityInput.value);
      save(RAW_KEY, String(this.rawInput.checked));
      save(VIEW_KEY, this.viewInput.value);
      save(ROOM_KEY, this.roomInput.value.trim());
      save(MODE_KEY, this.modeInput.value);
      this.nameLabel.textContent = name;
      this.showNotice(null);
      fn({
        name,
        sensitivity: Number(this.sensInput.value),
        quality: this.quality,
        rawMouse: this.rawInput.checked,
        view: this.viewInput.value as View,
        room: this.roomInput.value.trim(),
        mode: this.modeInput.value as GameMode,
      });
    };
    this.playBtn.addEventListener('click', start);
    // Enter anywhere on the menu enters the game.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.overlay.classList.contains('hidden')) {
        e.preventDefault();
        start();
      }
    });
  }

  /** Whether the player has entered the game at least once (the menu then acts as a pause menu). */
  get hasEntered(): boolean {
    return this.entered;
  }

  setPlaying(playing: boolean): void {
    this.overlay.classList.toggle('hidden', playing);
    document.body.classList.toggle('at-home', !playing);
    if (playing) this.entered = true;
    const paused = !playing && this.entered;
    document.body.classList.toggle('paused', paused);
    this.kicker.textContent = paused ? 'Paused' : 'Swing · Fight · With friends';
    this.playBtn.textContent = paused ? 'Resume' : 'Enter';
  }

  /**
   * Launch charge meter. The bar fills over 5 seconds; the zones show weak,
   * ramping, MAX and overcharged. null hides it.
   */
  setCharge(seconds: number | null): void {
    if (seconds === null) {
      if (this.chargeShown) this.charge.classList.add('hidden');
      this.chargeShown = false;
      return;
    }
    if (!this.chargeShown) this.charge.classList.remove('hidden');
    this.chargeShown = true;
    const pct = Math.min(1, seconds / CHARGE_SCALE) * 100;
    const power = launchPower(seconds);
    let label: string;
    let color: string;
    if (seconds > LAUNCH.overchargeAt) {
      label = 'OVERCHARGED: half power';
      color = '#e0393e';
    } else if (seconds >= LAUNCH.fullAt) {
      label = 'MAX: release now!';
      color = '#3fd46b';
    } else {
      label = `${Math.round(power * 100)}%`;
      color = '#f0c040';
    }
    this.chargeFill.style.width = `${pct}%`;
    this.chargeFill.style.background = color;
    this.chargeLabel.textContent = label;
  }

  /** "LAUNCH!" / "BOUNCE!" cue while Space is queued during a zip (null hides it). */
  setLaunchCue(text: string | null): void {
    if (text === this.launchCueText) return;
    this.launchCueText = text;
    if (text) this.launchCue.textContent = text;
    this.launchCue.classList.toggle('hidden', !text);
  }

  /** A short message on top of the game (null hides it). */
  showNotice(text: string | null): void {
    this.notice.textContent = text ?? '';
    this.notice.classList.toggle('hidden', !text);
  }

  setStats(lines: Record<string, string | number>): void {
    const text = Object.entries(lines)
      .map(([k, v]) => `${k.padEnd(7)} ${v}`)
      .join('\n');
    if (text !== this.last) {
      this.stats.textContent = text;
      this.last = text;
    }
  }
}
