import { LAUNCH, launchPower } from '@game/shared';

const NAME_KEY = 'swingfight.name';
const SENS_KEY = 'swingfight.sensitivity';
const QUALITY_KEY = 'swingfight.quality';
const RAW_KEY = 'swingfight.rawMouse';
const VIEW_KEY = 'swingfight.view';
const ROOM_KEY = 'swingfight.room';

export type Quality = 'high' | 'medium' | 'low';
export type View = 'third' | 'first';

export interface Settings {
  name: string;
  sensitivity: number;
  quality: Quality;
  rawMouse: boolean;
  view: View;
  room: string;
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

/** Start screen (name + settings) and the in-game overlay. */
export class Hud {
  private readonly stats = document.getElementById('stats')!;
  private readonly overlay = document.getElementById('overlay')!;
  private readonly notice = document.getElementById('notice')!;
  private readonly nameInput = document.getElementById('name-input') as HTMLInputElement;
  private readonly sensInput = document.getElementById('sens-input') as HTMLInputElement;
  private readonly sensValue = document.getElementById('sens-value')!;
  private readonly qualityInput = document.getElementById('quality-input') as HTMLSelectElement;
  private readonly rawInput = document.getElementById('raw-input') as HTMLInputElement;
  private readonly viewInput = document.getElementById('view-input') as HTMLSelectElement;
  private readonly roomInput = document.getElementById('room-input') as HTMLInputElement;
  private readonly playBtn = document.getElementById('play-btn') as HTMLButtonElement;
  private readonly nameLabel = document.getElementById('player-name')!;
  readonly minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
  private last = '';
  private readonly charge = document.getElementById('charge')!;
  private readonly chargeFill = document.getElementById('charge-fill')!;
  private readonly chargeLabel = document.getElementById('charge-label')!;
  private chargeShown = false;

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
    // A ?room=xyz link pre-fills the room, so you can send friends a direct link.
    this.roomInput.value = new URLSearchParams(location.search).get('room') ?? load(ROOM_KEY) ?? '';
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
      this.nameLabel.textContent = name;
      this.showNotice(null);
      fn({
        name,
        sensitivity: Number(this.sensInput.value),
        quality: this.quality,
        rawMouse: this.rawInput.checked,
        view: this.viewInput.value as View,
        room: this.roomInput.value.trim(),
      });
    };
    this.playBtn.addEventListener('click', start);
    for (const input of [this.nameInput, this.roomInput]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') start();
      });
    }
  }

  setPlaying(playing: boolean): void {
    this.overlay.classList.toggle('hidden', playing);
    this.playBtn.textContent = this.nameLabel.textContent ? 'Resume' : 'Play';
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
