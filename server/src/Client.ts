import type { WebSocket } from 'ws';
import { encode, NET, type HitFx, type NetState, type PlayerInfo, type ServerMessage, type Vec3 } from '@game/shared';
import { newCombatFields, recordHistory, type Actor } from './Actor';
import type { Room } from './Room';

/** One connected socket, before and after it joins a room. */
export class Client implements Actor {
  readonly isBot = false;
  info: PlayerInfo | null = null;
  room: Room | null = null;

  state: NetState | null = null;
  stateTime = 0;
  stateDirty = false;
  readonly history: { t: number; p: Vec3 }[] = [];

  hp: number;
  koUntil: number;
  protectUntil: number;
  downedUntil: number;
  readonly cooldowns: Map<string, number>;
  /** Web shots of ours still flying. */
  shotsInFlight = 0;

  lastMessageAt: number;
  private tokens: number = NET.rateLimitBurst;
  private tokensAt: number;
  /** Messages dropped by the rate limiter recently (sustained flooding => kick). */
  dropped = 0;

  constructor(
    readonly id: string,
    readonly socket: WebSocket,
    now: number,
  ) {
    this.lastMessageAt = now;
    this.tokensAt = now;
    const c = newCombatFields();
    this.hp = c.hp;
    this.koUntil = c.koUntil;
    this.protectUntil = c.protectUntil;
    this.downedUntil = c.downedUntil;
    this.cooldowns = c.cooldowns;
  }

  get joined(): boolean {
    return this.info !== null && this.room !== null;
  }

  send(msg: ServerMessage): void {
    this.sendRaw(encode(msg));
  }

  sendRaw(data: string): void {
    // 1 = OPEN. Never throw because one player's socket is closing.
    if (this.socket.readyState === 1) this.socket.send(data);
  }

  /** Players apply hit effects on their own client (it receives the 'dmg' message). */
  applyFx(_fx: HitFx, _now: number): void {}

  /** Token-bucket rate limit. Returns false if this message should be dropped. */
  allowMessage(now: number): boolean {
    this.tokens = Math.min(NET.rateLimitBurst, this.tokens + ((now - this.tokensAt) / 1000) * NET.rateLimitPerSecond);
    this.tokensAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.dropped = Math.max(0, this.dropped - 0.01);
      return true;
    }
    this.dropped++;
    return false;
  }

  recordState(state: NetState, now: number): void {
    this.state = state;
    this.stateTime = now;
    this.stateDirty = true;
    recordHistory(this, now);
  }
}
