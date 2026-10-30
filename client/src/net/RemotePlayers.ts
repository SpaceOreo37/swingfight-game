import * as THREE from 'three';
import { NET, NET_STATES, type NetEvent, type NetState, type PlayerInfo } from '@game/shared';
import { Avatar } from '../game/Avatar';
import { Nametag } from '../game/Nametag';
import { WebLine } from '../game/WebLine';
import { SnapshotBuffer } from './SnapshotBuffer';

const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _rope = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _wall = new THREE.Vector3();
const _side = new THREE.Vector3();
const _head = new THREE.Vector3();
const _zipTo = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Everything needed to draw one other player. */
class RemotePlayer {
  readonly buffer = new SnapshotBuffer();
  readonly group = new THREE.Group();
  readonly avatar: Avatar;
  readonly tag: Nametag;
  private readonly web = new WebLine();
  private readonly zipWeb = new WebLine();
  private readonly thwipWeb = new WebLine();
  private thwipAge = Infinity;
  private readonly thwipTo = new THREE.Vector3();
  /** Last drawn position (for the minimap); null until the first snapshot. */
  readonly drawn = new THREE.Vector3();
  hasPosition = false;

  constructor(readonly info: PlayerInfo) {
    this.avatar = new Avatar(info.color);
    this.tag = new Nametag(info.name, info.color);
    this.group.add(this.avatar.root, this.web.mesh, this.zipWeb.mesh, this.thwipWeb.mesh, this.tag.sprite);
    this.group.visible = false; // until we know where they are
  }

  onEvent(e: NetEvent): void {
    if (e.k === 'thwip') {
      this.thwipAge = 0;
      this.thwipTo.set(e.to[0], e.to[1], e.to[2]);
    }
  }

  update(renderTime: number, dt: number, camera: THREE.Camera): void {
    this.thwipAge += dt;
    const s = this.buffer.sample(renderTime);
    if (!s) return;
    this.group.visible = true;
    this.hasPosition = true;
    _pos.set(s.p[0], s.p[1], s.p[2]);
    _vel.set(s.v[0], s.v[1], s.v[2]);
    this.drawn.copy(_pos);
    const state = NET_STATES[s.s] ?? 'air';

    const webbed = (state === 'swing' || state === 'charge' || state === 'zip') && s.a;
    if (webbed) {
      _anchor.set(s.a![0], s.a![1], s.a![2]);
      _rope.subVectors(_anchor, _pos).normalize();
    }
    const onWall = state === 'wall' && s.w;
    if (onWall) _wall.set(s.w![0], 0, s.w![1]);

    this.avatar.update(_pos, s.y, webbed ? _rope : null, onWall ? _wall : null, _vel, dt, state === 'charge', this.thwipAge);

    // Webs, same rules as the local player in third person.
    if (webbed) {
      _hand.copy(_pos).addScaledVector(_rope, 1.9);
      if (state === 'charge') _hand.set(_pos.x + 0.1, _pos.y + 1.85, _pos.z);
    }
    if (webbed && state === 'zip') {
      _side.crossVectors(_rope, UP).normalize();
      const from = _head.copy(_hand).addScaledVector(_side, -0.6);
      this.zipWeb.update(from, _zipTo.copy(_anchor).addScaledVector(_side, -0.6));
      _hand.addScaledVector(_side, 0.15);
    } else this.zipWeb.update(_hand, null);
    this.web.update(_hand, webbed ? _anchor : null);
    _hand.set(_pos.x, _pos.y + 1.5, _pos.z);
    this.thwipWeb.update(_hand, this.thwipAge < 0.18 ? this.thwipTo : null);

    _head.set(_pos.x, _pos.y + 1.9, _pos.z);
    this.tag.update(_head, camera);
  }

  dispose(): void {
    this.tag.dispose();
    this.group.removeFromParent();
  }
}

/**
 * All other players in the room. Fed by the network, drawn every frame
 * NET.interpDelayMs in the past so movement is smooth.
 */
export class RemotePlayers {
  private readonly players = new Map<string, RemotePlayer>();

  constructor(private readonly scene: THREE.Scene) {}

  get count(): number {
    return this.players.size;
  }

  /** Replace everyone (after joining / reconnecting). */
  reset(players: PlayerInfo[]): void {
    for (const p of this.players.values()) p.dispose();
    this.players.clear();
    for (const info of players) this.add(info);
  }

  add(info: PlayerInfo): void {
    this.players.get(info.id)?.dispose();
    const p = new RemotePlayer(info);
    this.players.set(info.id, p);
    this.scene.add(p.group);
  }

  remove(id: string): void {
    this.players.get(id)?.dispose();
    this.players.delete(id);
  }

  pushState(id: string, serverTime: number, s: NetState): void {
    this.players.get(id)?.buffer.push(serverTime, s);
  }

  event(id: string, e: NetEvent): void {
    this.players.get(id)?.onEvent(e);
  }

  update(serverNow: number, dt: number, camera: THREE.Camera): void {
    const renderTime = serverNow - NET.interpDelayMs;
    for (const p of this.players.values()) p.update(renderTime, dt, camera);
  }

  /** Positions and colors for the minimap. */
  markers(): { x: number; z: number; color: number }[] {
    const out = [];
    for (const p of this.players.values()) if (p.hasPosition) out.push({ x: p.drawn.x, z: p.drawn.z, color: p.info.color });
    return out;
  }
}
