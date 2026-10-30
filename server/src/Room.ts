import { COMBAT, encode, NET, PLAYER_COLORS, type CityCollider, type CityLayout, type GameMode, type NetState, type ServerMessage, type Vec3 } from '@game/shared';
import type { Actor } from './Actor';
import { Bot, type BotPattern } from './Bot';
import type { Client } from './Client';
import { Combat } from './Combat';

/** Training dummies placed around the spawn point (offsets from spawn). */
const TRAINING_BOTS: { name: string; offset: Vec3; pattern: BotPattern }[] = [
  { name: 'Dummy A', offset: [0, 0, -25], pattern: 'stand' },
  { name: 'Dummy B', offset: [-6, 0, -45], pattern: 'stand' },
  { name: 'Walker', offset: [4, 0, -70], pattern: 'patrol' },
  { name: 'Flyer', offset: [0, 28, -60], pattern: 'flyer' },
  { name: 'Far Dummy', offset: [0, 0, -110], pattern: 'stand' },
];

/**
 * A group of players who can see each other (plus any training dummies).
 * Owns membership, the fixed-rate broadcast, and the room's combat rules.
 */
export class Room {
  readonly clients = new Map<string, Client>();
  readonly bots = new Map<string, Bot>();
  readonly combat: Combat;

  constructor(
    readonly name: string,
    readonly mode: GameMode,
    collider: CityCollider,
    city: CityLayout,
  ) {
    this.combat = new Combat(
      {
        actors: () => this.actors(),
        find: (id) => this.clients.get(id) ?? this.bots.get(id),
        broadcast: (msg) => this.broadcast(msg),
      },
      collider,
      mode,
    );
    if (mode === 'training') {
      TRAINING_BOTS.forEach((b, i) => {
        const id = `bot${i + 1}`;
        const home: Vec3 = [city.spawn.x + b.offset[0], city.spawn.y + b.offset[1], city.spawn.z + b.offset[2]];
        this.bots.set(id, new Bot(id, b.name, home, b.pattern, collider));
      });
    }
  }

  /** Real players only (rooms close when this hits 0). */
  get size(): number {
    return this.clients.size;
  }

  get isFull(): boolean {
    return this.clients.size >= NET.maxPlayersPerRoom;
  }

  *actors(): IterableIterator<Actor> {
    yield* this.clients.values();
    yield* this.bots.values();
  }

  /** First color not used by anyone in the room (falls back to cycling). */
  pickColor(): number {
    const used = new Set([...this.clients.values()].map((c) => c.info?.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.clients.size % PLAYER_COLORS.length];
  }

  /** Make a display name unique within the room ("Sam", "Sam 2", ...). */
  uniqueName(name: string): string {
    const taken = new Set([...this.actors()].map((c) => c.info?.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const suffix = ` ${i}`;
      const candidate = name.slice(0, NET.maxNameLength - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  add(client: Client, now: number): void {
    client.hp = COMBAT.maxHp;
    client.koUntil = 0;
    client.protectUntil = now + COMBAT.spawnProtectSeconds * 1000;
    this.clients.set(client.id, client);
    this.combat.pickIt(now);
  }

  remove(client: Client, now: number): void {
    if (!this.clients.delete(client.id)) return;
    this.combat.removeActor(client, now);
    this.broadcast({ t: 'leave', id: client.id });
  }

  broadcast(msg: ServerMessage, except?: Client): void {
    const data = encode(msg);
    for (const c of this.clients.values()) if (c !== except) c.sendRaw(data);
  }

  /** Health of everyone, for newcomers. */
  hpSnapshot(): Record<string, number> {
    const hp: Record<string, number> = {};
    for (const a of this.actors()) hp[a.id] = a.hp;
    return hp;
  }

  /**
   * Called at NET.tickRate: move dummies, run combat, then send every state
   * that changed since the last tick in one message. Clients skip their own entry.
   */
  tick(now: number, dt: number): void {
    for (const b of this.bots.values()) b.update(now, dt);
    this.combat.tick(now, dt);
    const states: [string, number, NetState][] = [];
    for (const a of this.actors()) {
      if (a.state && a.stateDirty) {
        states.push([a.id, a.stateTime, a.state]);
        a.stateDirty = false;
      }
    }
    if (states.length) this.broadcast({ t: 'snap', time: now, states });
  }
}
