/**
 * Network protocol shared by client and server. Every message that crosses
 * the wire is defined here, and every incoming message goes through a
 * validator below before anything trusts it.
 *
 * Rules for changing this file:
 *  - Any change to message shapes => bump PROTOCOL_VERSION. Old clients then
 *    get a clear "refresh the page" instead of subtle bugs.
 *  - Only add optional fields to existing messages when possible.
 *  - Keep validation strict: unknown/garbled messages are dropped, never guessed at.
 */

export const PROTOCOL_VERSION = 1;

export const NET = {
  /** Client sends its own state this many times per second. */
  sendRate: 20,
  /** Server broadcasts room state this many times per second. */
  tickRate: 20,
  /** Remote players are drawn this far in the past, so there are always two snapshots to blend. */
  interpDelayMs: 110,
  /** If snapshots stop arriving, keep predicting from velocity for at most this long. */
  maxExtrapolateMs: 250,
  maxPlayersPerRoom: 16,
  maxRooms: 200,
  maxNameLength: 16,
  maxRoomLength: 24,
  /** Messages bigger than this are rejected outright (bytes). */
  maxMessageBytes: 8 * 1024,
  /** Per-client message budget (token bucket): sustained rate and burst. */
  rateLimitPerSecond: 60,
  rateLimitBurst: 120,
  /** Drop a client that hasn't sent anything for this long (ms). */
  idleTimeoutMs: 20_000,
  /** How often the client pings for latency / clock sync (ms). */
  pingIntervalMs: 2000,
  /** Server keeps this much position history per player (ms), for future lag-compensated hits. */
  historyMs: 1000,
  /** Any speed above this is physically impossible in-game; such snapshots are rejected (m/s). */
  maxPlausibleSpeed: 120,
} as const;

/** Movement states, in a fixed order (sent as their index). Append only. */
export const NET_STATES = ['ground', 'air', 'swing', 'wall', 'charge', 'zip'] as const;
export type NetMoveState = (typeof NET_STATES)[number];

export type Vec3 = [number, number, number];

/** Public info about a player in a room. */
export interface PlayerInfo {
  id: string;
  name: string;
  /** 0xRRGGBB */
  color: number;
}

/** One player's movement state, as sent ~20 times a second. */
export interface NetState {
  /** Position (feet). */
  p: Vec3;
  /** Velocity. */
  v: Vec3;
  /** Body yaw (radians). */
  y: number;
  /** Index into NET_STATES. */
  s: number;
  /** Web anchor while swinging / charging / zipping. */
  a?: Vec3;
  /** Wall normal (x, z) while on a wall. */
  w?: [number, number];
}

/** One-shot effects other players should see (thwip now; attacks later). */
export interface NetEvent {
  k: 'thwip';
  /** Where the effect points (e.g. where the thwip web went). */
  to: Vec3;
}

// ---------------------------------------------------------------- messages

export type ClientMessage =
  | { t: 'hello'; v: number; name: string; room: string }
  | { t: 'state'; s: NetState }
  | { t: 'event'; e: NetEvent }
  | { t: 'ping'; c: number };

export type ServerMessage =
  /** You joined. `you` has your final name (made unique) and color; `players` is everyone else. */
  | { t: 'welcome'; you: PlayerInfo; seed: number; room: string; players: PlayerInfo[]; time: number }
  | { t: 'reject'; reason: 'version' | 'full' | 'bad-hello' | 'server-full'; message: string }
  | { t: 'join'; player: PlayerInfo }
  | { t: 'leave'; id: string }
  /** Batched states: [playerId, serverTimeMs when received, state]. */
  | { t: 'snap'; time: number; states: [string, number, NetState][] }
  | { t: 'event'; id: string; time: number; e: NetEvent }
  | { t: 'pong'; c: number; time: number };

// ---------------------------------------------------------------- encoding

/** Round to 2 decimals to keep JSON small (1 cm / 0.01 rad precision is plenty). */
const r2 = (n: number) => Math.round(n * 100) / 100;
const r2v = (v: Vec3): Vec3 => [r2(v[0]), r2(v[1]), r2(v[2])];

/** Make a state compact for sending. */
export function packState(s: NetState): NetState {
  const out: NetState = { p: r2v(s.p), v: r2v(s.v), y: r2(s.y), s: s.s };
  if (s.a) out.a = r2v(s.a);
  if (s.w) out.w = [r2(s.w[0]), r2(s.w[1])];
  return out;
}

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- validation

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const isVec3 = (x: unknown): x is Vec3 => Array.isArray(x) && x.length === 3 && x.every(isNum);

export function isNetState(x: unknown): x is NetState {
  if (!isObj(x)) return false;
  if (!isVec3(x.p) || !isVec3(x.v) || !isNum(x.y)) return false;
  if (!Number.isInteger(x.s) || (x.s as number) < 0 || (x.s as number) >= NET_STATES.length) return false;
  if (x.a !== undefined && !isVec3(x.a)) return false;
  if (x.w !== undefined && !(Array.isArray(x.w) && x.w.length === 2 && x.w.every(isNum))) return false;
  return true;
}

export function isNetEvent(x: unknown): x is NetEvent {
  return isObj(x) && x.k === 'thwip' && isVec3(x.to);
}

const isPlayerInfo = (x: unknown): x is PlayerInfo =>
  isObj(x) && isStr(x.id, 64) && isStr(x.name, NET.maxNameLength) && isNum(x.color);

/** Parse + validate a message from a client. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > NET.maxMessageBytes) return null;
  const m = parseJson(raw);
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'hello':
      return isNum(m.v) && isStr(m.name, 200) && isStr(m.room, 200) ? { t: 'hello', v: m.v, name: m.name, room: m.room } : null;
    case 'state':
      return isNetState(m.s) ? { t: 'state', s: m.s } : null;
    case 'event':
      return isNetEvent(m.e) ? { t: 'event', e: m.e } : null;
    case 'ping':
      return isNum(m.c) ? { t: 'ping', c: m.c } : null;
    default:
      return null;
  }
}

/** Parse + validate a message from the server. Returns null for anything malformed. */
export function parseServerMessage(raw: string): ServerMessage | null {
  const m = parseJson(raw);
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'welcome':
      return isPlayerInfo(m.you) && isNum(m.seed) && isStr(m.room, 200) && Array.isArray(m.players) && m.players.every(isPlayerInfo) && isNum(m.time)
        ? (m as ServerMessage)
        : null;
    case 'reject':
      return isStr(m.reason, 32) && isStr(m.message, 500) ? (m as ServerMessage) : null;
    case 'join':
      return isPlayerInfo(m.player) ? (m as ServerMessage) : null;
    case 'leave':
      return isStr(m.id, 64) ? (m as ServerMessage) : null;
    case 'snap':
      return isNum(m.time) &&
        Array.isArray(m.states) &&
        m.states.every((e) => Array.isArray(e) && e.length === 3 && isStr(e[0], 64) && isNum(e[1]) && isNetState(e[2]))
        ? (m as ServerMessage)
        : null;
    case 'event':
      return isStr(m.id, 64) && isNum(m.time) && isNetEvent(m.e) ? (m as ServerMessage) : null;
    case 'pong':
      return isNum(m.c) && isNum(m.time) ? (m as ServerMessage) : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- sanitizing

/** Clean a display name: no control characters, trimmed, length-limited. */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NET.maxNameLength);
  return cleaned || 'Player';
}

/** Room names: lowercase letters, digits, dashes. Empty => "main". */
export function sanitizeRoom(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, NET.maxRoomLength);
  return cleaned || 'main';
}

/** Distinct, readable player colors, assigned in order of joining. */
export const PLAYER_COLORS = [
  0xd23a3a, 0x2f7de1, 0x2ea84f, 0xe0a020, 0x9b4fd6, 0x17a5a5, 0xe0662b, 0xd6489a,
  0x6c8a2b, 0x3b4fb8, 0xb8862f, 0x8a3b3b, 0x2b8a6c, 0x6b6b6b, 0xc04ec0, 0x4e9ec0,
];
