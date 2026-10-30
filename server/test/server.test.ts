import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { NET, PROTOCOL_VERSION, encode, parseServerMessage, type ClientMessage, type NetState, type ServerMessage } from '@game/shared';
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

async function join(name: string, room = 'test') {
  const c = new TestClient();
  await c.opened();
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name, room });
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
    c.send({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'Old', room: 'x' });
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
    extra.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Extra', room: 'full' });
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
