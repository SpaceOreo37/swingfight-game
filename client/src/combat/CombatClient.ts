import * as THREE from 'three';
import { COMBAT, type CityCollider, type CityLayout, type GameMode, type HitKind } from '@game/shared';
import type { PlayerController } from '../game/PlayerController';
import { WebLine } from '../game/WebLine';
import type { GameMessage, Network } from '../net/Network';
import type { RemotePlayer, RemotePlayers } from '../net/RemotePlayers';
import type { CombatHud } from './CombatHud';

/** A web shot being drawn. */
interface Projectile {
  mesh: THREE.Mesh;
  o: THREE.Vector3;
  d: THREE.Vector3;
  /** Local time (s) it left the hand. */
  t0: number;
  len: number;
  sid: number | null;
  /** Our own id for it (only for our shots). */
  c: number | null;
  by: string;
}

interface Spark {
  sprite: THREE.Sprite;
  age: number;
}

export interface CombatInput {
  /** Left-click held (web shots auto-repeat at the fire rate). */
  fireHeld: boolean;
  /** C + left-click this frame. */
  strikePressed: boolean;
  /** E this frame. */
  yankPressed: boolean;
}

const FORWARD = new THREE.Vector3(0, 0, 1);
const CHEST = 1.2;
const POOL = 48;
/** Web shots aren't drawn until they're this far from the hand (m). */
const SHOT_HIDE_NEAR = 2.5;
const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _chest = new THREE.Vector3();

/**
 * Everything combat on the client: aiming with the crosshair, sending
 * shots / yanks / strikes / kicks, drawing web shots and hit sparks, and
 * reacting to what the server decides (damage, knockouts, respawns, tag).
 * The server is the judge; this side just aims, shows, and feels good.
 */
export class CombatClient {
  /** Health of everyone we know about (including us), by id. */
  readonly hp = new Map<string, number>();
  mode: GameMode = 'brawl';
  /** The player under the crosshair (null if none). */
  target: RemotePlayer | null = null;
  /** Seconds since we fired a web shot (drives the punch animation). */
  shotAge = Infinity;
  /** Where our last shot was headed (for the arm to point at). */
  readonly shotPoint = new THREE.Vector3();

  private readonly projectiles: Projectile[] = [];
  private readonly free: THREE.Mesh[] = [];
  private readonly sparks: Spark[] = [];
  private readonly sparkMaterial: THREE.SpriteMaterial;
  private shotSeq = 1;
  private fireCooldown = 0;
  private yankCooldown = 0;
  private readonly kickCooldowns = new Map<string, number>();
  private time = 0;
  /** Yank strands being shown: from (who) to (who). */
  private readonly yanks: { from: string; to: string; web: WebLine; age: number }[] = [];
  private tagIt: string | null = null;
  /** Who our zip strike is flying at. */
  private strikeTarget: string | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly collider: CityCollider,
    private readonly city: CityLayout,
    private readonly net: Network,
    private readonly remotes: RemotePlayers,
    private readonly player: PlayerController,
    private readonly hud: CombatHud,
    /** Camera shake for hits on us. */
    private readonly shake: (amount: number) => void,
  ) {
    const geo = new THREE.SphereGeometry(0.1, 8, 6).scale(1, 1, 5);
    const mat = new THREE.MeshBasicMaterial({ color: 0xf8f8ff });
    for (let i = 0; i < POOL; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.free.push(m);
    }
    this.sparkMaterial = new THREE.SpriteMaterial({ map: sparkTexture(), transparent: true, depthWrite: false, fog: false });
    // Strike lands when our zip reaches them: tell the server.
    this.player.onStrikeArrive = () => {
      if (this.strikeTarget) this.net.sendAct('strike', this.strikeTarget);
      this.strikeTarget = null;
    };
  }

  private get me(): string | null {
    return this.net.me?.id ?? null;
  }

  /** New room: reset everything. */
  reset(mode: GameMode, hp: Record<string, number>): void {
    this.mode = mode;
    this.hp.clear();
    for (const [id, v] of Object.entries(hp)) this.hp.set(id, v);
    for (const p of this.projectiles) this.release(p);
    this.projectiles.length = 0;
    for (const y of this.yanks) y.web.mesh.removeFromParent();
    this.yanks.length = 0;
    this.tagIt = null;
    this.hud.setMode(mode);
    this.hud.setHealth(this.myHp() / COMBAT.maxHp, mode !== 'tag' && mode !== 'race');
    this.hud.setTag(null, [], () => '');
    for (const [id, v] of this.hp) {
      const r = this.remotes.get(id);
      if (r) r.hp = v;
    }
  }

  myHp(): number {
    return this.me ? this.hp.get(this.me) ?? COMBAT.maxHp : COMBAT.maxHp;
  }

  // ---------------------------------------------------------------- per frame

  /**
   * @param camera for the crosshair ray
   * @param hand where web shots leave from (world)
   */
  update(dt: number, input: CombatInput, camera: THREE.Camera, hand: THREE.Vector3): void {
    this.time += dt;
    this.shotAge += dt;
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.yankCooldown = Math.max(0, this.yankCooldown - dt);
    const online = this.net.status === 'online';
    const canAct = online && !this.player.frozen && this.mode !== 'race';

    this.target = this.findTarget(camera);
    this.hud.setCrosshair(this.target !== null);

    if (canAct && input.fireHeld && this.fireCooldown === 0) this.fire(camera, hand);
    if (canAct && input.strikePressed && this.target) this.strike(this.target);
    if (canAct && input.yankPressed && this.target && this.yankCooldown === 0) this.yank(this.target);
    if (canAct) this.checkKicks();

    this.updateProjectiles();
    this.updateSparks(dt);
    this.updateYanks(dt, hand);
  }

  /** The player nearest the crosshair (generous near the center), with a clear line to them. */
  private findTarget(camera: THREE.Camera): RemotePlayer | null {
    camera.getWorldDirection(_dir);
    const cam = camera.position;
    let best: RemotePlayer | null = null;
    let bestScore = Infinity;
    for (const r of this.remotes.targets()) {
      targetPoint(r, _chest);
      _v.subVectors(_chest, cam);
      const along = _v.dot(_dir);
      if (along < 1 || along > COMBAT.strikeStartRange + 8) continue;
      const off = Math.sqrt(Math.max(0, _v.lengthSq() - along * along));
      // Forgiving: within ~1.3 m of the ray, or ~3.5 degrees at range.
      if (off > Math.max(1.3, along * 0.06)) continue;
      const score = off / along;
      if (score >= bestScore) continue;
      // Can't target through buildings (check from our chest).
      const from = this.player.pos;
      _v.set(_chest.x - from.x, _chest.y - (from.y + 1.4), _chest.z - from.z);
      const d = _v.length();
      if (d > COMBAT.strikeStartRange) continue;
      _v.divideScalar(d);
      const hit = this.collider.raycast(from.x, from.y + 1.4, from.z, _v.x, _v.y, _v.z, d);
      if (hit !== null && hit < d - 1) continue;
      best = r;
      bestScore = score;
    }
    return best;
  }

  // ---------------------------------------------------------------- actions

  private fire(camera: THREE.Camera, hand: THREE.Vector3): void {
    this.fireCooldown = COMBAT.shotCooldownMs / 1000;
    // Aim where the crosshair points: the target, or the first building, or far away.
    camera.getWorldDirection(_dir);
    const cam = camera.position;
    let dist = this.collider.raycast(cam.x, cam.y, cam.z, _dir.x, _dir.y, _dir.z, COMBAT.shotRange) ?? COMBAT.shotRange;
    if (this.target) {
      targetPoint(this.target, _chest);
      dist = Math.min(dist, _chest.distanceTo(cam));
    }
    _aim.copy(cam).addScaledVector(_dir, dist);
    const d = _v.subVectors(_aim, hand);
    if (d.length() < 2) d.copy(_dir);
    d.normalize();
    // How far until it hits a building (same answer the server will get).
    const len = this.collider.raycast(hand.x, hand.y, hand.z, d.x, d.y, d.z, COMBAT.shotRange) ?? COMBAT.shotRange;
    const c = this.shotSeq++;
    this.spawnProjectile(hand, d, len, null, c, this.me ?? '', 0);
    this.net.sendFire([hand.x, hand.y, hand.z], [d.x, d.y, d.z], c);
    this.shotAge = 0;
    this.shotPoint.copy(_aim);
  }

  private yank(t: RemotePlayer): void {
    this.yankCooldown = COMBAT.yankCooldownMs / 1000;
    this.net.sendAct('yank', t.info.id);
    if (this.me) this.showYank(this.me, t.info.id);
  }

  private strike(t: RemotePlayer): void {
    const id = t.info.id;
    const ok = this.player.startStrike(() => {
      const r = this.remotes.get(id);
      return r && !r.ko ? r.drawn : null;
    });
    if (ok) this.strikeTarget = id;
  }

  /** Swing kick: fly into someone fast enough and it's a kick (no button). */
  private checkKicks(): void {
    const p = this.player;
    if (p.state === 'ground' || p.state === 'charge' || p.state === 'zip') return;
    const speed = p.vel.length();
    if (speed < COMBAT.kickMinSpeed) return;
    for (const r of this.remotes.targets()) {
      const id = r.info.id;
      if ((this.kickCooldowns.get(id) ?? 0) > this.time) continue;
      _v.copy(r.drawn).sub(p.pos);
      // Body-to-body: close horizontally and vertically overlapping.
      if (Math.hypot(_v.x, _v.z) > 2.2 || Math.abs(_v.y) > 2.2) continue;
      this.kickCooldowns.set(id, this.time + COMBAT.kickCooldownMs / 1000);
      this.net.sendAct('kick', id);
      p.vel.multiplyScalar(0.75); // you lose some speed into them
      p.jolt += 0.5;
      _chest.copy(r.drawn).y += CHEST;
      this.spark(_chest, 2.2);
    }
  }

  // ---------------------------------------------------------------- server messages

  onMessage(m: GameMessage): void {
    const me = this.me;
    switch (m.t) {
      case 'shot': {
        if (m.by === me) {
          // Our own prediction: just remember the server's id for it.
          const own = this.projectiles.find((p) => p.c === m.c && p.by === me);
          if (own) own.sid = m.sid;
          return;
        }
        const age = Math.max(0, (this.net.serverNow() - m.time) / 1000);
        _v.set(m.o[0], m.o[1], m.o[2]);
        _dir.set(m.d[0], m.d[1], m.d[2]);
        this.spawnProjectile(_v, _dir, m.len, m.sid, null, m.by, age);
        this.remotes.get(m.by)?.punch();
        return;
      }
      case 'shotHit': {
        const i = this.projectiles.findIndex((p) => p.sid === m.sid);
        if (i >= 0) {
          this.release(this.projectiles[i]);
          this.projectiles.splice(i, 1);
        }
        _v.set(m.at[0], m.at[1], m.at[2]);
        this.spark(_v, 1.3);
        return;
      }
      case 'dmg': {
        this.hp.set(m.target, m.hp);
        const r = this.remotes.get(m.target);
        if (r) {
          r.hp = m.hp;
          if (m.fx.down) r.downTime = m.fx.down;
        }
        if (m.kind === 'yank' && m.by !== me) this.showYank(m.by, m.target);
        if (m.target === me) {
          this.player.applyHit(m.fx);
          this.hud.setHealth(m.hp / COMBAT.maxHp, this.mode !== 'tag');
          this.hud.hurt(m.kind === 'shot' ? 0.35 : 0.8);
          this.shake(m.kind === 'shot' ? 0.2 : 0.6);
        } else if (m.by === me) {
          this.hud.hitMarker(m.kind === 'slam' || m.kind === 'strike' || m.kind === 'kick');
        }
        return;
      }
      case 'ko': {
        this.hp.set(m.target, 0);
        const r = this.remotes.get(m.target);
        if (r) r.ko = true;
        this.hud.killFeed(this.nameOf(m.by), this.nameOf(m.target), m.kind);
        if (m.target === me) {
          this.player.knockOut();
          this.hud.knockedOut(this.nameOf(m.by), COMBAT.respawnSeconds);
        } else if (m.by === me) {
          this.hud.bigMessage(m.kind === 'slam' ? 'SLAM KO!' : 'KO!');
        }
        return;
      }
      case 'respawn': {
        this.hp.set(m.id, m.hp);
        const r = this.remotes.get(m.id);
        if (r) {
          r.hp = m.hp;
          r.ko = false;
          r.downTime = 0;
        }
        if (m.id === me) {
          const s = this.spawnPoint();
          this.player.respawnAt(s.x, s.y, s.z);
          this.hud.setHealth(1, this.mode !== 'tag');
          this.hud.knockedOut(null, 0);
        }
        return;
      }
      case 'tag': {
        const was = this.tagIt;
        this.tagIt = m.it;
        if (m.it === me && was !== me) this.hud.bigMessage("YOU'RE IT!");
        else if (was === me && m.it !== me) this.hud.bigMessage('TAGGED THEM!');
        this.hud.setTag(m.it, m.scores, (id) => (id === me ? 'You' : this.nameOf(id)), me);
        return;
      }
    }
  }

  private nameOf(id: string): string {
    if (id === this.me) return this.net.me?.name ?? 'You';
    return this.remotes.get(id)?.info.name ?? '???';
  }

  /** A spot to respawn: a street intersection near the middle of town, picked at random. */
  private spawnPoint(): THREE.Vector3 {
    const avenues = this.city.roads.filter((r) => r.along === 'z').map((r) => r.center);
    const streets = this.city.roads.filter((r) => r.along === 'x').map((r) => r.center);
    const near = (list: number[], c: number) => list.sort((a, b) => Math.abs(a - c) - Math.abs(b - c)).slice(0, 5);
    const xs = near(avenues, this.city.spawn.x);
    const zs = near(streets, this.city.spawn.z);
    return new THREE.Vector3(xs[Math.floor(Math.random() * xs.length)], 1, zs[Math.floor(Math.random() * zs.length)]);
  }

  // ---------------------------------------------------------------- visuals

  private spawnProjectile(o: THREE.Vector3, d: THREE.Vector3, len: number, sid: number | null, c: number | null, by: string, age: number): void {
    const mesh = this.free.pop();
    if (!mesh) return; // pool exhausted: skip drawing (the server still simulates it)
    mesh.visible = false; // shown once it's clear of the hand
    mesh.quaternion.setFromUnitVectors(FORWARD, d);
    this.projectiles.push({ mesh, o: o.clone(), d: d.clone(), t0: this.time - age, len, sid, c, by });
  }

  private release(p: Projectile): void {
    p.mesh.visible = false;
    this.free.push(p.mesh);
  }

  /** Move shots along; remove them where they hit a building (or ran out of range). */
  private updateProjectiles(): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const dist = (this.time - p.t0) * COMBAT.shotSpeed;
      if (dist >= p.len) {
        if (p.len < COMBAT.shotRange) this.spark(_v.copy(p.o).addScaledVector(p.d, p.len), 0.9);
        this.release(p);
        this.projectiles.splice(i, 1);
        continue;
      }
      p.mesh.position.copy(p.o).addScaledVector(p.d, dist);
      // Hidden for the first couple of meters: right at the hand it would
      // fill the first-person view.
      p.mesh.visible = dist > SHOT_HIDE_NEAR;
    }
  }

  private spark(at: THREE.Vector3, size: number): void {
    const sprite = new THREE.Sprite(this.sparkMaterial.clone());
    sprite.position.copy(at);
    sprite.scale.setScalar(size * 0.3);
    this.scene.add(sprite);
    this.sparks.push({ sprite, age: 0 });
    if (this.sparks.length > 40) this.dropSpark(0);
  }

  private updateSparks(dt: number): void {
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      const t = s.age / 0.35;
      if (t >= 1) {
        this.dropSpark(i);
        continue;
      }
      s.sprite.scale.multiplyScalar(1 + dt * 6);
      (s.sprite.material as THREE.SpriteMaterial).opacity = 1 - t;
    }
  }

  private dropSpark(i: number): void {
    const s = this.sparks[i];
    s.sprite.removeFromParent();
    (s.sprite.material as THREE.SpriteMaterial).dispose();
    this.sparks.splice(i, 1);
  }

  /** Yank strand for a moment between two players. */
  private showYank(from: string, to: string): void {
    const web = new WebLine();
    this.scene.add(web.mesh);
    this.yanks.push({ from, to, web, age: 0 });
  }

  private updateYanks(dt: number, myHand: THREE.Vector3): void {
    for (let i = this.yanks.length - 1; i >= 0; i--) {
      const y = this.yanks[i];
      y.age += dt;
      const fromPos = y.from === this.me ? myHand : this.remotes.positionOf(y.from);
      const toPos = y.to === this.me ? this.player.pos : this.remotes.positionOf(y.to);
      if (y.age > 0.35 || !fromPos || !toPos) {
        y.web.mesh.removeFromParent();
        this.yanks.splice(i, 1);
        continue;
      }
      _v.copy(fromPos);
      if (y.from !== this.me) _v.y += 1.5;
      _chest.copy(toPos).y += CHEST;
      y.web.update(_v, _chest);
    }
  }

}

/** Where to aim at someone: chest height standing, low when they're lying on the floor. */
function targetPoint(r: RemotePlayer, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(r.drawn).setY(r.drawn.y + (r.downTime > 0 ? 0.35 : CHEST));
}

export function kindLabel(k: HitKind): string {
  return { shot: 'web shot', kick: 'swing kick', strike: 'zip strike', slam: 'SLAM', yank: 'yank' }[k];
}

function sparkTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,240,200,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
