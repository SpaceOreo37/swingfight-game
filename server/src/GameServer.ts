import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  generateCity,
  NET,
  PROTOCOL_VERSION,
  parseClientMessage,
  sanitizeName,
  sanitizeRoom,
  WORLD_SEED,
  type ClientMessage,
  type NetState,
} from '@game/shared';
import { Client } from './Client';
import { Room } from './Room';
import { serveStatic } from './static';

export interface GameServerOptions {
  port: number;
  /** Built client to serve (client/dist). Optional: in dev, Vite serves the client. */
  staticDir?: string;
  /** Silence logs (tests). */
  quiet?: boolean;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
  stats(): { rooms: number; players: number };
}

/** Close codes we send (4000-4999 are free for apps). */
const CLOSE = { protocol: 4000, flood: 4001, idle: 4002, noHello: 4003, full: 4004 } as const;
/** A socket must say hello within this long (ms). */
const HELLO_TIMEOUT_MS = 5000;

/**
 * The multiplayer server: HTTP (static files + /health) and a WebSocket
 * endpoint at /ws. Everything a client sends is validated; nothing a client
 * does can crash the server or affect other rooms.
 */
export function startGameServer(opts: GameServerOptions): Promise<RunningServer> {
  const log = (...a: unknown[]) => {
    if (!opts.quiet) console.log(new Date().toISOString().slice(11, 19), ...a);
  };
  const started = Date.now();
  const now = () => Date.now() - started;

  // Positions outside the island (plus margin) are impossible: reject them.
  const city = generateCity(WORLD_SEED);
  const boundX = city.halfX + 100;
  const boundZ = city.halfZ + 100;

  const rooms = new Map<string, Room>();
  const clients = new Set<Client>();

  const http: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, ...stats() }));
      return;
    }
    if (opts.staticDir && serveStatic(req, res, opts.staticDir)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: NET.maxMessageBytes });

  function stats() {
    let players = 0;
    for (const r of rooms.values()) players += r.size;
    return { rooms: rooms.size, players };
  }

  function newId(): string {
    for (;;) {
      const id = randomBytes(5).toString('hex');
      if (![...clients].some((c) => c.id === id)) return id;
    }
  }

  wss.on('connection', (socket: WebSocket) => {
    const client = new Client(newId(), socket, now());
    clients.add(client);
    const helloTimer = setTimeout(() => {
      if (!client.joined) socket.close(CLOSE.noHello, 'No hello');
    }, HELLO_TIMEOUT_MS);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      const t = now();
      client.lastMessageAt = t;
      if (!client.allowMessage(t)) {
        if (client.dropped > NET.rateLimitBurst) socket.close(CLOSE.flood, 'Too many messages');
        return;
      }
      if (isBinary) return;
      const msg = parseClientMessage(data.toString());
      if (!msg) return; // malformed: ignore, never crash
      try {
        handle(client, msg, t);
      } catch (err) {
        // A bug in one handler must never take the server down.
        log('handler error', client.id, err);
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      clients.delete(client);
      const room = client.room;
      if (room) {
        room.remove(client);
        log(`leave  ${client.info?.name} (${client.id}) room=${room.name} players=${room.size}`);
        if (room.size === 0) rooms.delete(room.name);
      }
    });
    socket.on('error', () => {
      /* 'close' follows; nothing else to do */
    });
  });

  function handle(client: Client, msg: ClientMessage, t: number): void {
    if (msg.t === 'ping') {
      client.send({ t: 'pong', c: msg.c, time: t });
      return;
    }
    if (msg.t === 'hello') {
      if (client.joined) return;
      if (msg.v !== PROTOCOL_VERSION) {
        client.send({ t: 'reject', reason: 'version', message: 'The game was updated. Refresh the page to get the new version.' });
        client.socket.close(CLOSE.protocol, 'Protocol version');
        return;
      }
      const roomName = sanitizeRoom(msg.room);
      let room = rooms.get(roomName);
      if (!room) {
        if (rooms.size >= NET.maxRooms) {
          client.send({ t: 'reject', reason: 'server-full', message: 'The server is full. Try again later.' });
          client.socket.close(CLOSE.full, 'Server full');
          return;
        }
        room = new Room(roomName);
        rooms.set(roomName, room);
      }
      if (room.isFull) {
        client.send({ t: 'reject', reason: 'full', message: `Room "${roomName}" is full (${NET.maxPlayersPerRoom} players).` });
        client.socket.close(CLOSE.full, 'Room full');
        return;
      }
      client.info = { id: client.id, name: room.uniqueName(sanitizeName(msg.name)), color: room.pickColor() };
      client.room = room;
      const others = [...room.clients.values()].map((c) => c.info!).filter(Boolean);
      room.add(client);
      client.send({ t: 'welcome', you: client.info, seed: WORLD_SEED, room: room.name, players: others, time: t });
      room.broadcast({ t: 'join', player: client.info }, client);
      // Let the newcomer see everyone right away instead of waiting for movement.
      const states = [...room.clients.values()]
        .filter((c) => c !== client && c.state)
        .map((c) => [c.id, c.stateTime, c.state!] as [string, number, NetState]);
      if (states.length) client.send({ t: 'snap', time: t, states });
      log(`join   ${client.info.name} (${client.id}) room=${room.name} players=${room.size}`);
      return;
    }

    // Everything else requires being in a room.
    if (!client.joined) return;
    const room = client.room!;

    if (msg.t === 'state') {
      if (!plausible(msg.s)) return;
      client.recordState(msg.s, t);
      return;
    }
    if (msg.t === 'event') {
      room.broadcast({ t: 'event', id: client.id, time: t, e: msg.e }, client);
    }
  }

  /** Reject states no real client could produce (cheap sanity, not full anti-cheat). */
  function plausible(s: NetState): boolean {
    const [x, y, z] = s.p;
    if (Math.abs(x) > boundX || Math.abs(z) > boundZ || y < -10 || y > 2000) return false;
    if (Math.hypot(s.v[0], s.v[1], s.v[2]) > NET.maxPlausibleSpeed) return false;
    if (s.a && Math.hypot(s.a[0] - x, s.a[1] - y, s.a[2] - z) > 500) return false;
    return true;
  }

  // Fixed-rate broadcast, plus dropping silent connections.
  const tickTimer = setInterval(() => {
    const t = now();
    for (const room of rooms.values()) room.tick(t);
    for (const c of clients) {
      if (t - c.lastMessageAt > NET.idleTimeoutMs) c.socket.close(CLOSE.idle, 'Idle');
    }
  }, 1000 / NET.tickRate);

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      log(`Swingfight server on :${port} (protocol v${PROTOCOL_VERSION})${opts.staticDir ? ` serving ${opts.staticDir}` : ''}`);
      resolve({
        port,
        stats,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(tickTimer);
            for (const c of clients) c.socket.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}
