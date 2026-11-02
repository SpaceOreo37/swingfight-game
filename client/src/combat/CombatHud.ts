import type { GameMode, HitKind } from '@game/shared';
import { kindLabel } from './CombatClient';

const MODE_LABEL: Record<GameMode, string> = { brawl: 'Brawl', training: 'Training', tag: 'Tag', race: 'Race' };

/**
 * Combat screen elements: crosshair + hit markers, health bar, kill feed,
 * knockout screen, big center messages, and the tag panel. Only touches the
 * DOM when something actually changes.
 */
export class CombatHud {
  private readonly crosshair = el('crosshair');
  private readonly hitmark = el('hitmarker');
  private readonly hpBox = el('hp-box');
  private readonly hpFill = el('hp-fill');
  private readonly hurtEl = el('hurt');
  private readonly feed = el('killfeed');
  private readonly koEl = el('ko-screen');
  private readonly koText = el('ko-text');
  private readonly big = el('big-msg');
  private readonly tagEl = el('tag-panel');
  private readonly modeEl = el('mode-badge');
  private onTarget = false;
  private lastHp = -1;
  private koTimer: ReturnType<typeof setInterval> | null = null;
  private bigTimer: ReturnType<typeof setTimeout> | null = null;
  private hitTimer: ReturnType<typeof setTimeout> | null = null;

  setMode(mode: GameMode): void {
    this.modeEl.textContent = MODE_LABEL[mode];
    this.modeEl.classList.remove('hidden');
    this.tagEl.classList.toggle('hidden', mode !== 'tag');
    // No crosshair in races (no shooting).
    this.crosshair.classList.toggle('hidden', mode === 'race');
  }

  /** Red crosshair when a player is under it (yank / zip strike will work). */
  setCrosshair(onTarget: boolean): void {
    if (onTarget === this.onTarget) return;
    this.onTarget = onTarget;
    this.crosshair.classList.toggle('on-target', onTarget);
  }

  /** X flash when our hit lands (bigger for heavy hits). */
  hitMarker(heavy: boolean): void {
    this.hitmark.classList.remove('show', 'heavy');
    void this.hitmark.offsetWidth; // restart the animation
    this.hitmark.classList.add('show');
    if (heavy) this.hitmark.classList.add('heavy');
    if (this.hitTimer) clearTimeout(this.hitTimer);
    this.hitTimer = setTimeout(() => this.hitmark.classList.remove('show', 'heavy'), 250);
  }

  /** Health 0..1. Hidden in modes without damage. */
  setHealth(frac: number, show: boolean): void {
    this.hpBox.classList.toggle('hidden', !show);
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    if (pct === this.lastHp) return;
    this.lastHp = pct;
    this.hpFill.style.width = `${pct}%`;
    this.hpFill.style.background = pct > 50 ? '#3fd46b' : pct > 25 ? '#f0c040' : '#e0393e';
  }

  /** Red flash at the screen edges when we get hit. */
  hurt(strength: number): void {
    this.hurtEl.style.transition = 'none';
    this.hurtEl.style.opacity = String(Math.min(1, strength));
    void this.hurtEl.offsetWidth;
    this.hurtEl.style.transition = 'opacity 0.6s ease-out';
    this.hurtEl.style.opacity = '0';
  }

  killFeed(by: string, target: string, kind: HitKind): void {
    const row = document.createElement('div');
    row.className = 'feed-row';
    const a = document.createElement('b');
    a.textContent = by;
    const b = document.createElement('b');
    b.textContent = target;
    row.append(a, ` ${kind === 'slam' ? '💥' : '⟶'} `, b, document.createTextNode(` (${kindLabel(kind)})`));
    this.feed.prepend(row);
    while (this.feed.children.length > 5) this.feed.lastChild?.remove();
    setTimeout(() => row.classList.add('fade'), 4500);
    setTimeout(() => row.remove(), 5200);
  }

  /** Knocked-out screen with a countdown. `by = null` hides it. */
  knockedOut(by: string | null, seconds: number): void {
    if (this.koTimer) clearInterval(this.koTimer);
    this.koTimer = null;
    if (by === null) {
      this.koEl.classList.add('hidden');
      return;
    }
    this.koEl.classList.remove('hidden');
    let left = seconds;
    const draw = () => (this.koText.textContent = `Knocked out by ${by} · back in ${Math.max(0, Math.ceil(left))}`);
    draw();
    this.koTimer = setInterval(() => {
      left -= 0.25;
      draw();
    }, 250);
  }

  bigMessage(text: string): void {
    this.big.textContent = text;
    this.big.classList.remove('show');
    void this.big.offsetWidth;
    this.big.classList.add('show');
    if (this.bigTimer) clearTimeout(this.bigTimer);
    this.bigTimer = setTimeout(() => this.big.classList.remove('show'), 1400);
  }

  /** Tag panel: who's it, and seconds-as-it per player (lowest wins). */
  setTag(it: string | null, scores: [string, number][], name: (id: string) => string, me: string | null = null): void {
    this.tagEl.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tag-head' + (it && it === me ? ' you' : '');
    head.textContent = it ? (it === me ? "YOU'RE IT!" : `${name(it)} is it`) : 'Waiting for another player…';
    this.tagEl.append(head);
    for (const [id, s] of [...scores].sort((a, b) => a[1] - b[1]).slice(0, 6)) {
      const row = document.createElement('div');
      row.textContent = `${name(id)} · ${s.toFixed(1)}s`;
      if (id === it) row.className = 'is-it';
      this.tagEl.append(row);
    }
  }
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}
