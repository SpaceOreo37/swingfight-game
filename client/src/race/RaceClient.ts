import * as THREE from 'three';
import { formatRaceTime, raceCourse, type CityLayout, type RaceCourse, type RacePhase } from '@game/shared';
import { bindingName } from '../game/Controls';
import type { PlayerController } from '../game/PlayerController';
import type { GameMessage, Network } from '../net/Network';
import type { RemotePlayers } from '../net/RemotePlayers';

const NEXT = new THREE.Color(0xffd23f);
const FINISH = new THREE.Color(0x3fd46b);
const LATER = new THREE.Color(0xffffff);

/** Our current run, as the server reports it. */
interface MyRun {
  /** Index of the next ring to fly through. */
  next: number;
  /** Local clock (performance.now ms) when the run's timer started. */
  startedAt: number;
  group: boolean;
  /** Final time once finished. */
  finished: number | null;
}

/**
 * Race mode on the client: draws the rings, the beacon over the next ring,
 * the race HUD, and lines everyone up for group races. The server decides
 * which rings you've passed; this side just shows it.
 */
export class RaceClient {
  readonly course: RaceCourse;
  active = false;
  private readonly group = new THREE.Group();
  private readonly rings: THREE.Mesh[] = [];
  private readonly beacon: THREE.Mesh;
  private phase: RacePhase = 'idle';
  private startAt = 0;
  private racers: string[] = [];
  private run: MyRun | null = null;
  private best: [string, number][] = [];
  private last: [string, number][] = [];
  /** Who is how far, for the live list during a group race. */
  private readonly progress = new Map<string, number>();
  private lastCountdown = -1;
  private time = 0;

  private readonly panel = document.getElementById('race-panel')!;
  private readonly timerEl = document.getElementById('race-timer')!;
  private readonly infoEl = document.getElementById('race-info')!;
  private readonly boardEl = document.getElementById('race-board')!;
  private lastHtml = '';

  constructor(
    scene: THREE.Scene,
    city: CityLayout,
    private readonly net: Network,
    private readonly remotes: RemotePlayers,
    private readonly player: PlayerController,
    private readonly bigMessage: (text: string) => void,
  ) {
    this.course = raceCourse(city);
    const cps = this.course.checkpoints;
    const ringGeo = new THREE.TorusGeometry(this.course.radius, 0.45, 8, 48);
    for (let i = 0; i < cps.length; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: LATER, transparent: true, opacity: 0.25, depthWrite: false, fog: false });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.position.set(...cps[i]);
      // Face along the course: from the previous ring toward the next one.
      const from = cps[Math.max(0, i - 1)];
      const to = cps[Math.min(cps.length - 1, i + 1)];
      const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      if (dir.lengthSq() > 0.01) ring.lookAt(ring.position.clone().add(dir));
      this.rings.push(ring);
      this.group.add(ring);
    }
    // The finish shares the start's spot; only draw it once you're heading there.
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 400, 12, 1, true).translate(0, 200, 0),
      new THREE.MeshBasicMaterial({ color: NEXT, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide }),
    );
    this.group.add(this.beacon);
    this.group.visible = false;
    scene.add(this.group);
  }

  setActive(on: boolean): void {
    this.active = on;
    this.group.visible = on;
    this.panel.classList.toggle('hidden', !on);
    if (!on) {
      this.run = null;
      this.player.frozen = false;
    }
  }

  /** We respawned: the server drops a time trial when you teleport, so do the same here. */
  onRespawn(): void {
    if (this.run && !this.run.group) this.run = null;
  }

  /** Ask the server to start a group race for everyone in the room. */
  requestStart(): void {
    if (this.active && this.phase === 'idle') this.net.sendRaceStart();
  }

  /** Minimap dot for the next ring. */
  marker(): { x: number; z: number; color: number } | null {
    if (!this.active) return null;
    const i = this.targetIndex();
    const p = this.course.checkpoints[i];
    return { x: p[0], z: p[2], color: i === this.course.checkpoints.length - 1 ? 0x3fd46b : 0xffd23f };
  }

  onMessage(m: GameMessage): void {
    const me = this.net.me?.id;
    switch (m.t) {
      case 'race': {
        const wasPhase = this.phase;
        this.phase = m.phase;
        this.startAt = m.startAt;
        this.racers = m.racers;
        if (m.phase === 'countdown' && me && m.racers.includes(me)) {
          this.lineUp(m.racers.indexOf(me));
          this.run = { next: 0, startedAt: 0, group: true, finished: null };
          this.progress.clear();
          this.lastCountdown = -1;
        }
        if (m.phase === 'running' && wasPhase === 'countdown') {
          this.player.frozen = false;
          if (this.run?.group) this.run.startedAt = performance.now() - Math.max(0, this.net.serverNow() - m.startAt);
          this.bigMessage('GO!');
        }
        if (m.phase === 'idle' && wasPhase !== 'idle') {
          this.player.frozen = false;
          if (this.run?.group && this.run.finished === null) this.run = null; // race over, didn't finish
        }
        return;
      }
      case 'raceCp': {
        this.progress.set(m.id, m.cp);
        if (m.id !== me) return;
        if (m.cp === 0 && !m.group) {
          this.run = { next: 1, startedAt: performance.now(), group: false, finished: null };
          this.bigMessage('GO!');
          return;
        }
        if (!this.run) return;
        this.run.next = m.cp + 1;
        if (m.cp === m.total - 1) {
          this.run.finished = m.time;
          const pb = this.myBest();
          this.bigMessage(`FINISH ${formatRaceTime(m.time)}${pb !== null && m.time <= pb ? ' · BEST!' : ''}`);
        }
        return;
      }
      case 'raceBoard': {
        this.best = m.best;
        this.last = m.last;
        return;
      }
    }
  }

  update(dt: number): void {
    if (!this.active) return;
    this.time += dt;
    const cps = this.course.checkpoints;
    const next = this.targetIndex();
    const finishing = next === cps.length - 1;

    // Rings: next one bright (green if it's the finish), the one after dimmer, the rest faint.
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i];
      const mat = ring.material as THREE.MeshBasicMaterial;
      // Start (0) and finish (last) share a spot: show whichever one matters now.
      if (i === cps.length - 1) ring.visible = finishing;
      else if (i === 0) ring.visible = !finishing;
      else ring.visible = true;
      if (i === next) {
        mat.color.copy(finishing ? FINISH : NEXT);
        mat.opacity = 0.85 + Math.sin(this.time * 6) * 0.15;
        ring.scale.setScalar(1 + Math.sin(this.time * 4) * 0.04);
      } else if (i === next + 1) {
        mat.color.copy(LATER);
        mat.opacity = 0.45;
        ring.scale.setScalar(1);
      } else {
        mat.color.copy(LATER);
        mat.opacity = i < next && this.run ? 0.06 : 0.18;
        ring.scale.setScalar(1);
      }
    }
    const t = cps[next];
    this.beacon.position.set(t[0], t[1] - 4, t[2]);
    (this.beacon.material as THREE.MeshBasicMaterial).color.copy(finishing ? FINISH : NEXT);

    // Countdown numbers.
    if (this.phase === 'countdown' && this.run?.group) {
      const left = Math.ceil((this.startAt - this.net.serverNow()) / 1000);
      if (left !== this.lastCountdown && left >= 1 && left <= 5) {
        this.lastCountdown = left;
        this.bigMessage(String(left));
      }
    }
    this.renderHud();
  }

  /** The ring to fly to next (the start ring when not in a run). */
  private targetIndex(): number {
    if (!this.run || this.run.finished !== null) return 0;
    return Math.min(this.run.next, this.course.checkpoints.length - 1);
  }

  private myBest(): number | null {
    const me = this.net.me?.id;
    return this.best.find(([id]) => id === me)?.[1] ?? null;
  }

  /** Stand in a row behind the start ring, frozen until GO. */
  private lineUp(slot: number): void {
    const cps = this.course.checkpoints;
    const s = cps[0];
    const n = cps[1];
    const dir = new THREE.Vector3(n[0] - s[0], 0, n[2] - s[2]).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const row = Math.floor(slot / 4);
    const col = (slot % 4) - 1.5;
    const p = new THREE.Vector3(s[0], 0, s[2]).addScaledVector(dir, -14 - row * 5).addScaledVector(side, col * 4);
    this.player.respawnAt(p.x, 1, p.z);
    this.player.frozen = true;
  }

  private nameOf(id: string): string {
    if (id === this.net.me?.id) return 'You';
    return this.remotes.get(id)?.info.name ?? '???';
  }

  private renderHud(): void {
    const cps = this.course.checkpoints;
    const total = cps.length - 1; // rings after the start
    let timer = '--:--.--';
    let info: string;
    if (this.run && this.run.finished !== null) {
      timer = formatRaceTime(this.run.finished);
      info = `Finished! ${this.run.group ? '' : 'Fly through the start ring to go again'}`;
    } else if (this.run && this.phase === 'countdown' && this.run.group) {
      timer = '0:00.00';
      info = 'Get ready…';
    } else if (this.run) {
      timer = this.run.startedAt ? formatRaceTime(performance.now() - this.run.startedAt) : '0:00.00';
      info = `Ring ${Math.min(this.run.next, total)} / ${total}${this.run.group ? ' · group race' : ' · time trial'}`;
    } else if (this.phase === 'running') {
      info = 'A race is on: fly through the gold start ring for a time trial';
    } else {
      info = `Fly through the gold ring to start a time trial · ${bindingName('raceStart')} = race everyone`;
    }

    const rows: string[] = [];
    if (this.phase !== 'idle' && this.racers.length > 1) {
      const live = [...this.racers].sort((a, b) => (this.progress.get(b) ?? -1) - (this.progress.get(a) ?? -1));
      rows.push('<div class="race-head">Race</div>');
      for (const id of live) rows.push(`<div>${esc(this.nameOf(id))} · ${Math.max(0, this.progress.get(id) ?? 0)}/${total}</div>`);
    } else if (this.last.length) {
      rows.push('<div class="race-head">Last race</div>');
      this.last.slice(0, 5).forEach(([id, ms], i) => rows.push(`<div>${i + 1}. ${esc(this.nameOf(id))} · ${formatRaceTime(ms)}</div>`));
    }
    if (this.best.length) {
      rows.push('<div class="race-head">Best times</div>');
      this.best.slice(0, 5).forEach(([id, ms], i) => rows.push(`<div>${i + 1}. ${esc(this.nameOf(id))} · ${formatRaceTime(ms)}</div>`));
    }
    const html = rows.join('');
    if (this.timerEl.textContent !== timer) this.timerEl.textContent = timer;
    if (this.infoEl.textContent !== info) this.infoEl.textContent = info;
    if (html !== this.lastHtml) {
      this.boardEl.innerHTML = html;
      this.lastHtml = html;
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

