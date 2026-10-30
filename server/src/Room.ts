import { encode, NET, PLAYER_COLORS, type ServerMessage } from '@game/shared';
import type { Client } from './Client';

/**
 * A group of players who can see each other. Owns who's in it and the
 * fixed-rate broadcast of everyone's latest movement.
 */
export class Room {
  readonly clients = new Map<string, Client>();

  constructor(readonly name: string) {}

  get size(): number {
    return this.clients.size;
  }

  get isFull(): boolean {
    return this.clients.size >= NET.maxPlayersPerRoom;
  }

  /** First color not used by anyone in the room (falls back to cycling). */
  pickColor(): number {
    const used = new Set([...this.clients.values()].map((c) => c.info?.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.clients.size % PLAYER_COLORS.length];
  }

  /** Make a display name unique within the room ("Sam", "Sam 2", ...). */
  uniqueName(name: string): string {
    const taken = new Set([...this.clients.values()].map((c) => c.info?.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const suffix = ` ${i}`;
      const candidate = name.slice(0, NET.maxNameLength - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  add(client: Client): void {
    this.clients.set(client.id, client);
  }

  remove(client: Client): void {
    if (!this.clients.delete(client.id)) return;
    this.broadcast({ t: 'leave', id: client.id });
  }

  broadcast(msg: ServerMessage, except?: Client): void {
    const data = encode(msg);
    for (const c of this.clients.values()) if (c !== except) c.sendRaw(data);
  }

  /**
   * Called at NET.tickRate: send every state that changed since the last tick,
   * in one message. Clients skip their own entry.
   */
  tick(now: number): void {
    const states: [string, number, NonNullable<Client['state']>][] = [];
    for (const c of this.clients.values()) {
      if (c.state && c.stateDirty) {
        states.push([c.id, c.stateTime, c.state]);
        c.stateDirty = false;
      }
    }
    if (states.length) this.broadcast({ t: 'snap', time: now, states });
  }
}
