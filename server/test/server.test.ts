import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
  COMBAT,
  NET,
  PROTOCOL_VERSION,
  WORLD_SEED,
  encode,
  generateCity,
  parseServerMessage,
  raceCourse,
  RACE,
  type ClientMessage,
  type GameMode,
  type NetState,
  type ServerMessage,
  type Vec3,
} from '@game/shared';
import { startGameServer, type RunningServer } from '../src/GameServer';

let server: RunningServer;
let url: string;

before(async () => {
  server = await startGameServer({ port: 0, quiet: true });
  url = `ws://localhost:${server.port}/ws`;
});
after(async () => {
  await server.close();
});

/** A scripted test client: collects every message, lets tests wait for specific ones. */
class TestClient {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  closeCode: number | null = null;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor() {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      const m = parseServerMessage(d.toString());
      assert.ok(m, `server sent an invalid message: ${d}`);
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    this.ws.on('close', (code) => (this.closeCode = code));
  }

  opened(): Promise<void> {
    return new Promise((r) => (this.ws.readyState === WebSocket.OPEN ? r() : this.ws.once('open', () => r())));
  }

  closed(): Promise<number> {
    return new Promise((r) => (this.closeCode !== null ? r(this.closeCode) : this.ws.once('close', (c) => r(c))));
  }

  send(m: ClientMessage | string): void {
    this.ws.send(typeof m === 'string' ? m : encode(m));
  }

  waitFor<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 2000) {
    type M = Extract<ServerMessage, { t: T }>;
    const found = this.inbox.find((m) => m.t === t && pred(m as M));
    if (found) return Promise.resolve(found as M);
    return new Promise<M>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for '${t}'`)), ms);
      this.waiters.push({
        pred: (m) => m.t === t && pred(m as M),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as M);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function join(name: string, room = 'test', mode: GameMode = 'brawl') {
  const c = new TestClient();
  await c.opened();
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name, room, mode });
  const welcome = await c.waitFor('welcome');
  return { c, welcome };
}

const state = (x: number, extra: Partial<NetState> = {}): NetState => ({ p: [x, 10, 0], v: [1, 0, 0], y: 0, s: 1, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('game server', () => {
  it('answers health checks', async () => {
    const res = await fetch(`http://localhost:${server.port}/health`);
    const body = (await res.json()) as { ok: boolean; protocol: number };
    assert.equal(body.ok, true);
    assert.equal(body.protocol, PROTOCOL_VERSION);
  });

  it('joins players, makes names unique, gives different colors', async () => {
    const a = await join('Sam', 'names');
    const joinSeen = a.c.waitFor('join');
    const b = await join('Sam', 'names');
    assert.equal(a.welcome.you.name, 'Sam');
    assert.equal(b.welcome.you.name, 'Sam 2');
    assert.notEqual(a.welcome.you.color, b.welcome.you.color);
    assert.deepEqual(b.welcome.players.map((p) => p.id), [a.welcome.you.id]);
    assert.equal((await joinSeen).player.id, b.welcome.you.id);
    a.c.close();
    b.c.close();
  });

  it('sanitizes names and room names', async () => {
    const a = await join('  \u0000Evil‮  name that is way too long  ', 'Room With Spaces!!');
    assert.equal(a.welcome.you.name, 'Evil name that i');
    assert.equal(a.welcome.room, 'roomwithspaces');
    const b = await join('   ', '');
    assert.equal(b.welcome.you.name, 'Player');
    assert.equal(b.welcome.room, 'main');
    a.c.close();
    b.c.close();
  });

  it('relays movement to others in the room, and only that room', async () => {
    const a = await join('A', 'relay');
    const b = await join('B', 'relay');
    const outsider = await join('C', 'elsewhere');
    a.c.send({ t: 'state', s: state(5, { a: [10, 40, 0] }) });
    const snap = await b.c.waitFor('snap', (m) => m.states.some(([id]) => id === a.welcome.you.id));
    const [, time, s] = snap.states.find(([id]) => id === a.welcome.you.id)!;
    assert.ok(time >= 0);
    assert.deepEqual(s.p, [5, 10, 0]);
    assert.deepEqual(s.a, [10, 40, 0]);
    await sleep(150);
    assert.ok(!outsider.c.inbox.some((m) => m.t === 'snap'), 'other rooms must not see this room');
    for (const x of [a, b, outsider]) x.c.close();
  });

  it('sends existing players to a newcomer immediately', async () => {
    const a = await join('Early', 'late-join');
    a.c.send({ t: 'state', s: state(7) });
    await sleep(120);
    const b = await join('Late', 'late-join');
    const snap = await b.c.waitFor('snap', (m) => m.states.some(([id]) => id === a.welcome.you.id));
    assert.ok(snap);
    a.c.close();
    b.c.close();
  });

  it('relays events (thwip) to others but not back to the sender', async () => {
    const a = await join('A', 'events');
    const b = await join('B', 'events');
    a.c.send({ t: 'event', e: { k: 'thwip', to: [1, 2, 3] } });
    const ev = await b.c.waitFor('event');
    assert.equal(ev.id, a.welcome.you.id);
    assert.deepEqual(ev.e.to, [1, 2, 3]);
    await sleep(100);
    assert.ok(!a.c.inbox.some((m) => m.t === 'event'));
    a.c.close();
    b.c.close();
  });

  it('tells others when a player leaves', async () => {
    const a = await join('A', 'leave');
    const b = await join('B', 'leave');
    a.c.close();
    const left = await b.c.waitFor('leave');
    assert.equal(left.id, a.welcome.you.id);
    b.c.close();
  });

  it('survives garbage and ignores impossible states', async () => {
    const a = await join('A', 'garbage');
    const b = await join('B', 'garbage');
    const junk = [
      'not json',
      '{}',
      '[]',
      'null',
      '{"t":"state"}',
      '{"t":"state","s":{"p":[1,2],"v":[0,0,0],"y":0,"s":0}}',
      '{"t":"state","s":{"p":[1,2,3],"v":[0,0,0],"y":0,"s":99}}',
      '{"t":"state","s":{"p":["1",2,3],"v":[0,0,0],"y":0,"s":0}}',
      '{"t":"event","e":{"k":"nuke","to":[0,0,0]}}',
      '{"t":"hello","v":1,"name":"again","room":"other"}',
      '{"__proto__":{"t":"state"}}',
      'x'.repeat(NET.maxMessageBytes - 10),
    ];
    for (const j of junk) a.c.send(j);
    a.c.send({ t: 'state', s: state(1, { v: [500, 0, 0] }) }); // impossibly fast
    a.c.send({ t: 'state', s: state(99999) }); // far outside the city
    await sleep(200);
    assert.ok(!b.c.inbox.some((m) => m.t === 'snap'), 'no junk state may reach other players');
    // Still connected and still working.
    a.c.send({ t: 'state', s: state(3) });
    await b.c.waitFor('snap', (m) => m.states.some(([, , s]) => s.p[0] === 3));
    assert.equal(a.c.closeCode, null);
    a.c.close();
    b.c.close();
  });

  it('rejects an outdated client with a clear message', async () => {
    const c = new TestClient();
    await c.opened();
    c.send({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'Old', room: 'x', mode: 'brawl' });
    const rej = await c.waitFor('reject');
    assert.equal(rej.reason, 'version');
    assert.equal(await c.closed(), 4000);
  });

  it('ignores gameplay messages before hello', async () => {
    const c = new TestClient();
    await c.opened();
    c.send({ t: 'state', s: state(1) });
    c.send({ t: 'ping', c: 42 });
    const pong = await c.waitFor('pong');
    assert.equal(pong.c, 42);
    c.close();
  });

  it('kicks a client that floods messages', async () => {
    const a = await join('Flood', 'flood');
    for (let i = 0; i < NET.rateLimitBurst * 3; i++) a.c.send({ t: 'ping', c: i });
    assert.equal(await a.c.closed(), 4001);
  });

  it('turns players away from a full room', async () => {
    const players = [];
    for (let i = 0; i < NET.maxPlayersPerRoom; i++) players.push(await join(`P${i}`, 'full'));
    const extra = new TestClient();
    await extra.opened();
    extra.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Extra', room: 'full', mode: 'brawl' });
    const rej = await extra.waitFor('reject');
    assert.equal(rej.reason, 'full');
    for (const p of players) p.c.close();
  });

  it('cleans up empty rooms', async () => {
    await sleep(100);
    const before = server.stats();
    const a = await join('Solo', 'cleanup');
    assert.equal(server.stats().rooms, before.rooms + 1);
    a.c.close();
    await a.c.closed();
    await sleep(50);
    assert.equal(server.stats().rooms, before.rooms);
  });
});

// ---------------------------------------------------------------- combat

const spawn = generateCity(WORLD_SEED).spawn;
const at = (dx: number, dy: number, dz: number): Vec3 => [spawn.x + dx, spawn.y + dy, spawn.z + dz];
const dirTo = (from: Vec3, to: Vec3): Vec3 => {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
};
/** Latest position the client has heard for someone. */
const lastPos = (c: TestClient, id: string): Vec3 | null => {
  for (let i = c.inbox.length - 1; i >= 0; i--) {
    const m = c.inbox[i];
    if (m.t === 'snap') for (const [sid, , s] of m.states) if (sid === id) return s.p;
  }
  return null;
};

describe('combat', () => {
  it('training rooms come with dummies at full health', async () => {
    const a = await join('Trainer', 'train-1', 'training');
    assert.equal(a.welcome.mode, 'training');
    const bots = a.welcome.players.filter((p) => p.bot);
    assert.equal(bots.length, 5);
    for (const b of bots) assert.equal(a.welcome.hp[b.id], COMBAT.maxHp);
    await a.c.waitFor('snap', (m) => m.states.some(([id]) => id === 'bot1'));
    a.c.close();
  });

  it('a web shot flies, hits a dummy, and does damage', async () => {
    const a = await join('Shooter', 'train-2', 'training');
    a.c.send({ t: 'state', s: { p: at(0, 0, 0), v: [0, 0, 0], y: 0, s: 0 } });
    await a.c.waitFor('snap', (m) => m.states.some(([id]) => id === 'bot1'));
    await sleep(150);
    const o = at(0, 1.5, 0);
    const target = lastPos(a.c, 'bot1')!;
    a.c.send({ t: 'fire', o, d: dirTo(o, [target[0], target[1] + 1.2, target[2]]), vt: a.welcome.time + 200, c: 1 });
    const shot = await a.c.waitFor('shot');
    assert.equal(shot.c, 1);
    assert.ok(shot.len > 20, 'nothing between us and the dummy');
    const hit = await a.c.waitFor('shotHit');
    assert.equal(hit.target, 'bot1');
    const dmg = await a.c.waitFor('dmg', (m) => m.target === 'bot1');
    assert.equal(dmg.kind, 'shot');
    assert.equal(dmg.hp, COMBAT.maxHp - COMBAT.shotDamage);
    assert.ok(dmg.fx.slow);
    a.c.close();
  });

  it('a shot into a building simply ends (nothing left on the server)', async () => {
    const a = await join('Wall', 'train-3', 'training');
    // Mid-block on the avenue (spawn itself is an intersection, with a clear street sideways).
    a.c.send({ t: 'state', s: { p: at(0, 0, -35), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(100);
    a.c.send({ t: 'fire', o: at(0, 1.5, -35), d: [1, 0, 0], vt: a.welcome.time, c: 7 });
    const shot = await a.c.waitFor('shot');
    assert.ok(shot.len < 30, `should stop at the building beside the avenue (len ${shot.len})`);
    await sleep(400);
    assert.ok(!a.c.inbox.some((m) => m.t === 'shotHit'));
    assert.equal(server.stats().shots, 0);
    a.c.close();
  });

  it('limits how fast you can shoot', async () => {
    const a = await join('Spam', 'train-4', 'training');
    a.c.send({ t: 'state', s: { p: at(0, 0, 0), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(100);
    for (let i = 0; i < 30; i++) a.c.send({ t: 'fire', o: at(0, 1.5, 0), d: [0, 1, 0], vt: a.welcome.time, c: i });
    await sleep(200);
    const shots = a.c.inbox.filter((m) => m.t === 'shot').length;
    assert.ok(shots >= 1 && shots <= 3, `${shots} shots got through a 30-shot burst`);
    a.c.close();
  });

  it('ignores shots that do not start at the shooter', async () => {
    const a = await join('Cheat', 'train-5', 'training');
    a.c.send({ t: 'state', s: { p: at(0, 0, 0), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(100);
    a.c.send({ t: 'fire', o: at(0, 1.5, -24), d: [0, 0, -1], vt: a.welcome.time, c: 1 });
    await sleep(200);
    assert.ok(!a.c.inbox.some((m) => m.t === 'shot'));
    a.c.close();
  });

  it('yank downs a dummy; a strike on a downed target is a fatal slam; then it respawns', async () => {
    const a = await join('Yanker', 'train-6', 'training');
    a.c.send({ t: 'state', s: { p: at(0, 0, 0), v: [0, 0, 0], y: 0, s: 0 } });
    await a.c.waitFor('snap', (m) => m.states.some(([id]) => id === 'bot1'));
    await sleep(150);
    a.c.send({ t: 'act', k: 'yank', target: 'bot1', vt: Date.now() });
    const yank = await a.c.waitFor('dmg', (m) => m.kind === 'yank');
    assert.equal(yank.target, 'bot1');
    assert.ok(yank.fx.down && yank.fx.down > 0);
    assert.ok(yank.fx.imp![2] > 0, 'pulled toward the yanker (+z)');
    // It arcs over and lands on the floor a few meters in front of us.
    await sleep(900);
    const p = lastPos(a.c, 'bot1')!;
    const gap = Math.hypot(p[0] - spawn.x, p[2] - spawn.z);
    assert.ok(gap < 8, `dummy should land near the yanker (landed ${gap.toFixed(1)} m away)`);
    assert.ok(p[1] < 0.5, 'on the floor');
    a.c.send({ t: 'state', s: { p: [p[0], p[1], p[2] + 1.5], v: [0, 0, -20], y: 0, s: 5 } });
    await sleep(80);
    a.c.send({ t: 'act', k: 'strike', target: 'bot1', vt: 1e12 });
    const slam = await a.c.waitFor('dmg', (m) => m.kind === 'slam');
    assert.equal(slam.hp, 0);
    const ko = await a.c.waitFor('ko');
    assert.equal(ko.target, 'bot1');
    const back = await a.c.waitFor('respawn', (m) => m.id === 'bot1', COMBAT.respawnSeconds * 1000 + 1500);
    assert.equal(back.hp, COMBAT.maxHp);
    a.c.close();
  });

  it('rejects out-of-range yanks and slow kicks', async () => {
    const a = await join('Rules', 'train-7', 'training');
    a.c.send({ t: 'state', s: { p: at(0, 0, 0), v: [0, 0, 0], y: 0, s: 0 } });
    await a.c.waitFor('snap', (m) => m.states.some(([id]) => id === 'bot5'));
    await sleep(150);
    a.c.send({ t: 'act', k: 'yank', target: 'bot5', vt: 1e12 }); // Far Dummy, 110 m away
    const p = lastPos(a.c, 'bot1')!;
    a.c.send({ t: 'state', s: { p: [p[0], p[1], p[2] + 1], v: [0, 0, -2], y: 0, s: 0 } });
    await sleep(80);
    a.c.send({ t: 'act', k: 'kick', target: 'bot1', vt: 1e12 }); // way too slow to kick
    await sleep(200);
    assert.ok(!a.c.inbox.some((m) => m.t === 'dmg'));
    // A fast pass, though, lands.
    a.c.send({ t: 'state', s: { p: [p[0], p[1], p[2] + 1], v: [0, -5, -30], y: 0, s: 2 } });
    await sleep(80);
    a.c.send({ t: 'act', k: 'kick', target: 'bot1', vt: 1e12 });
    const kick = await a.c.waitFor('dmg', (m) => m.kind === 'kick');
    assert.ok(kick.amount > COMBAT.kickDamageBase);
    a.c.close();
  });

  it('players can shoot each other in brawl (after spawn protection)', async () => {
    const a = await join('Gunner', 'brawl-1', 'brawl');
    const b = await join('Target', 'brawl-1', 'brawl');
    a.c.send({ t: 'state', s: { p: at(0, 0, 0), v: [0, 0, 0], y: 0, s: 0 } });
    b.c.send({ t: 'state', s: { p: at(0, 0, -20), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(COMBAT.spawnProtectSeconds * 1000 + 100);
    b.c.send({ t: 'state', s: { p: at(0, 0, -20), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(100);
    const o = at(0, 1.5, 0);
    a.c.send({ t: 'fire', o, d: dirTo(o, at(0, 1.2, -20)), vt: 1e12, c: 1 });
    const dmg = await b.c.waitFor('dmg', (m) => m.target === b.welcome.you.id);
    assert.equal(dmg.by, a.welcome.you.id);
    assert.equal(dmg.hp, COMBAT.maxHp - COMBAT.shotDamage);
    a.c.close();
    b.c.close();
  });

  it('a yanked player is helpless while down, and cannot be yank-locked', async () => {
    const a = await join('Yanker', 'brawl-2', 'brawl');
    const b = await join('Victim', 'brawl-2', 'brawl');
    a.c.send({ t: 'state', s: { p: at(0, 0, 0), v: [0, 0, 0], y: 0, s: 0 } });
    b.c.send({ t: 'state', s: { p: at(0, 0, -20), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(COMBAT.spawnProtectSeconds * 1000 + 100);
    b.c.send({ t: 'state', s: { p: at(0, 0, -20), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(100);
    a.c.send({ t: 'act', k: 'yank', target: b.welcome.you.id, vt: 1e12 });
    await b.c.waitFor('dmg', (m) => m.kind === 'yank');
    // While down: shots and attacks from the victim are ignored.
    const o = at(0, 1.5, -20);
    b.c.send({ t: 'fire', o, d: dirTo(o, at(0, 1.2, 0)), vt: 1e12, c: 1 });
    b.c.send({ t: 'act', k: 'yank', target: a.welcome.you.id, vt: 1e12 });
    // And yanking them again right away (after the yank cooldown) does nothing either.
    await sleep(COMBAT.yankCooldownMs + 50);
    a.c.send({ t: 'act', k: 'yank', target: b.welcome.you.id, vt: 1e12 });
    await sleep(200);
    assert.ok(!a.c.inbox.some((m) => m.t === 'dmg' && m.target === a.welcome.you.id), 'downed player hit back');
    assert.equal(b.c.inbox.filter((m) => m.t === 'dmg' && m.kind === 'yank').length, 1, 'yanked twice in a row');
    // Once up again, they can shoot.
    await sleep(COMBAT.yankDown * 1000 + COMBAT.yankImmuneMs - COMBAT.yankCooldownMs);
    b.c.send({ t: 'state', s: { p: at(0, 0, -20), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(80);
    b.c.send({ t: 'fire', o, d: dirTo(o, at(0, 1.2, 0)), vt: 1e12, c: 1 });
    await a.c.waitFor('dmg', (m) => m.target === a.welcome.you.id && m.kind === 'shot');
    a.c.close();
    b.c.close();
  });

  it('tag: a hit from "it" passes it on, with no damage', async () => {
    const a = await join('TagA', 'tag-1', 'tag');
    const b = await join('TagB', 'tag-1', 'tag');
    const first = await a.c.waitFor('tag', (m) => m.it !== null);
    const it = first.it === a.welcome.you.id ? a : b;
    const other = it === a ? b : a;
    it.c.send({ t: 'state', s: { p: at(0, 0, 0), v: [0, 0, 0], y: 0, s: 0 } });
    other.c.send({ t: 'state', s: { p: at(0, 0, -15), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(COMBAT.spawnProtectSeconds * 1000 + 100);
    other.c.send({ t: 'state', s: { p: at(0, 0, -15), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(100);
    const o = at(0, 1.5, 0);
    it.c.send({ t: 'fire', o, d: dirTo(o, at(0, 1.2, -15)), vt: 1e12, c: 1 });
    const passed = await other.c.waitFor('tag', (m) => m.it === other.welcome.you.id);
    assert.ok(passed);
    const dmg = await other.c.waitFor('dmg');
    assert.equal(dmg.amount, 0);
    a.c.close();
    b.c.close();
  });
});

// ---------------------------------------------------------------- race

const course = raceCourse(generateCity(WORLD_SEED));
const cps = course.checkpoints;
/** Positions from a to b in steps short enough not to look like a teleport. */
function pathBetween(a: Vec3, b: Vec3, step = 30): Vec3[] {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.ceil(d / step));
  return Array.from({ length: n }, (_, i) => {
    const u = (i + 1) / n;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u] as Vec3;
  });
}
async function fly(c: TestClient, points: Vec3[]) {
  for (const p of points) {
    c.send({ t: 'state', s: { p, v: [0, 0, 0], y: 0, s: 1 } });
    await sleep(12); // stay well under the rate limit
  }
}
/** A point just before the start ring (so the next move passes through it). */
const beforeStart: Vec3 = [cps[0][0], cps[0][1], cps[0][2] + 20];

describe('race', () => {
  it('the course loops and every ring is in open air', () => {
    assert.ok(cps.length >= 10);
    assert.deepEqual(cps[0], cps[cps.length - 1]);
  });

  it('a solo time trial: start ring starts the clock, every ring counts in order, finish records a best time', async () => {
    const a = await join('Racer', 'race-1', 'race');
    assert.equal(a.welcome.mode, 'race');
    await fly(a.c, [beforeStart, cps[0]]);
    const started = await a.c.waitFor('raceCp', (m) => m.cp === 0 && !m.group);
    assert.equal(started.total, cps.length);
    let pos = cps[0];
    for (let i = 1; i < cps.length; i++) {
      await fly(a.c, pathBetween(pos, cps[i]));
      pos = cps[i];
    }
    const finish = await a.c.waitFor('raceCp', (m) => m.cp === cps.length - 1, 4000);
    assert.ok(finish.time > 0);
    const board = await a.c.waitFor('raceBoard', (m) => m.best.length > 0);
    assert.equal(board.best[0][0], a.welcome.you.id);
    a.c.close();
  });

  it('skipping a ring does not count, and teleports never pass rings', async () => {
    const a = await join('Cutter', 'race-2', 'race');
    await fly(a.c, [beforeStart, cps[0]]);
    await a.c.waitFor('raceCp', (m) => m.cp === 0);
    // Fly straight to ring 2, skipping ring 1.
    await fly(a.c, pathBetween(cps[0], [cps[2][0] + 200, cps[2][1], cps[2][2]]));
    // Teleport right onto ring 1 (respawn-style jump).
    await fly(a.c, [cps[1]]);
    await sleep(150);
    assert.ok(!a.c.inbox.some((m) => m.t === 'raceCp' && m.cp > 0), 'no rings should count');
    a.c.close();
  });

  it('a group race: countdown, nothing counts before GO, then finishing order', async () => {
    const a = await join('Fast', 'race-3', 'race');
    const b = await join('Slow', 'race-3', 'race');
    await fly(a.c, [beforeStart]);
    await fly(b.c, [beforeStart]);
    a.c.send({ t: 'raceStart' });
    const cd = await b.c.waitFor('race', (m) => m.phase === 'countdown');
    assert.equal(cd.racers.length, 2);
    // Jumping the gun: passing the start ring during the countdown doesn't count.
    await fly(a.c, [cps[0], beforeStart]);
    await sleep(100);
    assert.ok(!a.c.inbox.some((m) => m.t === 'raceCp'));
    await a.c.waitFor('race', (m) => m.phase === 'running', RACE.countdownMs + 1000);
    // A finishes first, then B.
    for (const c of [a.c, b.c]) {
      let pos: Vec3 = beforeStart;
      for (const cp of cps) {
        await fly(c, pathBetween(pos, cp));
        pos = cp;
      }
    }
    const board = await a.c.waitFor('raceBoard', (m) => m.last.length === 2, 6000);
    assert.deepEqual(board.last.map(([id]) => id), [a.welcome.you.id, b.welcome.you.id]);
    await a.c.waitFor('race', (m) => m.phase === 'idle');
    a.c.close();
    b.c.close();
  });

  it('no web shots in race mode', async () => {
    const a = await join('NoGuns', 'race-4', 'race');
    a.c.send({ t: 'state', s: { p: at(0, 0, 0), v: [0, 0, 0], y: 0, s: 0 } });
    await sleep(100);
    a.c.send({ t: 'fire', o: at(0, 1.5, 0), d: [0, 0, -1], vt: 1e12, c: 1 });
    await sleep(200);
    assert.ok(!a.c.inbox.some((m) => m.t === 'shot'));
    a.c.close();
  });
});
