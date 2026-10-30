import { COMBAT, NET, type HitFx, type NetState, type PlayerInfo, type ServerMessage, type Vec3 } from '@game/shared';

/** Anything in a room that has a body: a connected player or a training dummy. */
export interface Actor {
  readonly id: string;
  readonly isBot: boolean;
  info: PlayerInfo | null;

  /** Latest movement state and when the server got it. */
  state: NetState | null;
  stateTime: number;
  /** Changed since the last room tick. */
  stateDirty: boolean;
  /** Recent positions with server timestamps (for rewinding to what an attacker saw). */
  readonly history: { t: number; p: Vec3 }[];

  // Combat.
  hp: number;
  /** Knocked out until this server time (ms). */
  koUntil: number;
  /** Can't be damaged until this time (just respawned). */
  protectUntil: number;
  /** On the floor from a yank until this time. */
  downedUntil: number;
  /** Last time (ms) each kind of attack was used, keyed "kind" or "kind:target". */
  readonly cooldowns: Map<string, number>;

  send(msg: ServerMessage): void;
  /** Dummies apply hit effects themselves; players' own clients do it. */
  applyFx(fx: HitFx, now: number): void;
}

export function newCombatFields() {
  return { hp: COMBAT.maxHp, koUntil: 0, protectUntil: 0, downedUntil: 0, cooldowns: new Map<string, number>() };
}

export function recordHistory(a: Actor, now: number): void {
  if (!a.state) return;
  a.history.push({ t: now, p: [a.state.p[0], a.state.p[1], a.state.p[2]] });
  while (a.history.length && a.history[0].t < now - NET.historyMs) a.history.shift();
}

/** Where an actor was at server time t (blended between history samples). */
export function positionAt(a: Actor, t: number): Vec3 | null {
  const h = a.history;
  if (!h.length) return a.state ? [...a.state.p] : null;
  if (t <= h[0].t) return [...h[0].p];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].t <= t) {
      const next = h[i + 1];
      if (!next) return [...h[i].p];
      const u = (t - h[i].t) / (next.t - h[i].t || 1);
      return [
        h[i].p[0] + (next.p[0] - h[i].p[0]) * u,
        h[i].p[1] + (next.p[1] - h[i].p[1]) * u,
        h[i].p[2] + (next.p[2] - h[i].p[2]) * u,
      ];
    }
  }
  return [...h[h.length - 1].p];
}

export function isAlive(a: Actor, now: number): boolean {
  return a.koUntil <= now && a.state !== null;
}
