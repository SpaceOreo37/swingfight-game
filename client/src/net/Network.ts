import {
  encode,
  NET,
  packState,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type GameMode,
  type NetEvent,
  type NetState,
  type PlayerInfo,
  type ServerMessage,
} from '@game/shared';

export type NetStatus = 'offline' | 'connecting' | 'online' | 'rejected';

/** Combat / game messages from the server, passed straight through. */
export type GameMessage = Extract<ServerMessage, { t: 'shot' | 'shotHit' | 'dmg' | 'ko' | 'respawn' | 'tag' }>;

export interface NetHandlers {
  /** Joined (or re-joined after a reconnect). `players` = everyone else already in the room (incl. dummies). */
  welcome(me: PlayerInfo, players: PlayerInfo[], room: string, mode: GameMode, hp: Record<string, number>): void;
  /** Combat and mode messages. */
  game(msg: GameMessage): void;
  join(player: PlayerInfo): void;
  leave(id: string): void;
  state(id: string, serverTime: number, state: NetState): void;
  event(id: string, serverTime: number, e: NetEvent): void;
  status(status: NetStatus, message?: string): void;
}

/** Reconnect delays (ms), then stays at the last one. */
const BACKOFF = [500, 1000, 2000, 4000, 8000];

/**
 * The client's connection to the game server. Handles reconnecting,
 * latency + server-clock estimation, and validates everything received.
 * Gameplay code never touches the socket directly.
 */
export class Network {
  status: NetStatus = 'offline';
  /** Round-trip time to the server (ms). */
  rtt = 0;
  me: PlayerInfo | null = null;
  room = '';

  private socket: WebSocket | null = null;
  private name = '';
  private wantRoom = '';
  private wantMode: GameMode = 'brawl';
  mode: GameMode = 'brawl';
  private wantConnected = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** serverTime ≈ performance.now() + clockOffset */
  private clockOffset = 0;
  private clockSynced = false;
  private readonly clockSamples: { rtt: number; offset: number }[] = [];

  constructor(private readonly handlers: NetHandlers) {
    // Leaving the page: close cleanly so others see us leave right away.
    window.addEventListener('pagehide', () => this.disconnect());
  }

  /** Connect (or switch name/room/mode). Safe to call repeatedly. */
  connect(name: string, room: string, mode: GameMode): void {
    const same = this.wantConnected && name === this.name && room === this.wantRoom && mode === this.wantMode;
    this.name = name;
    this.wantRoom = room;
    this.wantMode = mode;
    this.wantConnected = true;
    if (same && this.socket) return;
    this.closeSocket();
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.wantConnected = false;
    this.closeSocket();
    this.setStatus('offline');
  }

  /** Current server time (ms), estimated. */
  serverNow(): number {
    return performance.now() + this.clockOffset;
  }

  sendState(s: NetState): void {
    this.send({ t: 'state', s: packState(s) });
  }

  sendEvent(e: NetEvent): void {
    this.send({ t: 'event', e });
  }

  /** Web shot. `c` is our own id for it (the server echoes it back). */
  sendFire(o: [number, number, number], d: [number, number, number], c: number): void {
    this.send({ t: 'fire', o, d, vt: this.viewTime(), c });
  }

  sendAct(k: 'kick' | 'strike' | 'yank', target: string): void {
    this.send({ t: 'act', k, target, vt: this.viewTime() });
  }

  /** The server time we're currently drawing other players at (for lag-compensated hits). */
  viewTime(): number {
    return this.serverNow() - NET.interpDelayMs;
  }

  // ---------------------------------------------------------------- internals

  private url(): string {
    // ?server=host:port lets you point at another server for testing.
    const override = new URLSearchParams(location.search).get('server');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return override ? `${proto}://${override}/ws` : `${proto}://${location.host}/ws`;
  }

  private open(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, room: this.wantRoom, mode: this.wantMode });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const msg = parseServerMessage(ev.data);
      if (msg) this.handle(msg);
    };
    ws.onclose = () => {
      if (this.socket !== ws) return; // an old socket we already replaced
      this.socket = null;
      this.stopPing();
      if (this.status === 'rejected') return;
      if (this.wantConnected) this.scheduleReconnect();
      else this.setStatus('offline');
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        this.attempt = 0;
        this.room = msg.room;
        this.me = msg.you;
        this.mode = msg.mode;
        this.clockOffset = msg.time - performance.now();
        this.clockSynced = false;
        this.clockSamples.length = 0;
        this.startPing();
        this.setStatus('online');
        this.handlers.welcome(this.me, msg.players, msg.room, msg.mode, msg.hp);
        break;
      }
      case 'join':
        if (msg.player.id !== this.me?.id) this.handlers.join(msg.player);
        break;
      case 'leave':
        this.handlers.leave(msg.id);
        break;
      case 'snap':
        for (const [id, t, s] of msg.states) if (id !== this.me?.id) this.handlers.state(id, t, s);
        break;
      case 'event':
        this.handlers.event(msg.id, msg.time, msg.e);
        break;
      case 'pong':
        this.onPong(msg.c, msg.time);
        break;
      case 'shot':
      case 'shotHit':
      case 'dmg':
      case 'ko':
      case 'respawn':
      case 'tag':
        this.handlers.game(msg);
        break;
      case 'reject':
        this.setStatus('rejected', msg.message);
        this.wantConnected = false;
        break;
    }
  }

  /**
   * Clock sync: each pong tells us the server time at (roughly) the middle
   * of the round trip. Trust the samples with the lowest round-trip time,
   * and move the estimate gently so remote players never jump.
   */
  private onPong(sentAt: number, serverTime: number): void {
    const now = performance.now();
    const rtt = now - sentAt;
    if (rtt < 0 || rtt > 10_000) return;
    this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
    this.clockSamples.push({ rtt, offset: serverTime + rtt / 2 - now });
    if (this.clockSamples.length > 10) this.clockSamples.shift();
    const best = this.clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    if (!this.clockSynced || Math.abs(best.offset - this.clockOffset) > 250) {
      this.clockOffset = best.offset;
      this.clockSynced = true;
    } else {
      this.clockOffset += (best.offset - this.clockOffset) * 0.2;
    }
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', c: performance.now() });
    ping();
    // A couple of quick pings first so the clock is right from the start.
    setTimeout(ping, 200);
    setTimeout(ping, 500);
    this.pingTimer = setInterval(ping, NET.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    this.setStatus('connecting');
    const base = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt++;
    // A little randomness so a server restart isn't hit by everyone at once.
    this.reconnectTimer = setTimeout(() => this.open(), base * (0.8 + Math.random() * 0.4));
  }

  private closeSocket(): void {
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    }
  }

  private send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encode(msg));
  }

  private setStatus(status: NetStatus, message?: string): void {
    if (this.status === status && !message) return;
    this.status = status;
    this.handlers.status(status, message);
  }
}
