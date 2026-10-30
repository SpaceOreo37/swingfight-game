import type { WebSocket } from 'ws';
import { encode, NET, type NetState, type PlayerInfo, type ServerMessage, type Vec3 } from '@game/shared';
import type { Room } from './Room';

/** One connected socket, before and after it joins a room. */
export class Client {
  info: PlayerInfo | null = null;
  room: Room | null = null;

  /** Latest movement state and when the server received it. */
  state: NetState | null = null;
  stateTime = 0;
  /** Changed since the last room tick. */
  stateDirty = false;
  /**
   * Recent positions with server timestamps. Not used yet: it's here so
   * combat can check hits against where a player WAS when someone attacked
   * (lag compensation) without changing the networking later.
   */
  readonly history: { t: number; p: Vec3 }[] = [];

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
    this.history.push({ t: now, p: state.p });
    while (this.history.length && this.history[0].t < now - NET.historyMs) this.history.shift();
  }
}
