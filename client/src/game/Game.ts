import * as THREE from 'three';
import { CityCollider, NET, NET_STATES, THWIP, WORLD_SEED, generateCity, type CityLayout, type NetState } from '@game/shared';
import { Input } from './Input';
import { bindingName } from './Controls';
import { PlayerController } from './PlayerController';
import { CameraRig } from './CameraRig';
import { Avatar } from './Avatar';
import { WebLine } from './WebLine';
import { SwingMarker } from './SwingMarker';
import { FirstPersonArms } from './FirstPersonArms';
import { SpeedLines } from '../ui/SpeedLines';
import { Network, type NetStatus } from '../net/Network';
import { RemotePlayers } from '../net/RemotePlayers';
import { Nametag } from './Nametag';
import { CombatClient } from '../combat/CombatClient';
import { CombatHud } from '../combat/CombatHud';
import { buildCity } from './CityRenderer';
import { Hud, type Quality, type View } from '../ui/Hud';
import { Minimap } from '../ui/Minimap';

/** Physics runs at a fixed 60Hz no matter the monitor refresh rate. */
const FIXED_DT = 1 / 60;
/** Frame cap: draw at most 60 frames a second. */
const FRAME_MS = 1000 / 60;

/** Fixed graphics presets (no automatic resolution switching: it caused hitches). */
const QUALITY: Record<Quality, { pixelRatio: number; shadows: boolean; shadowSize: number }> = {
  high: { pixelRatio: Math.min(window.devicePixelRatio, 1.5), shadows: true, shadowSize: 2048 },
  medium: { pixelRatio: 1, shadows: true, shadowSize: 1024 },
  low: { pixelRatio: 0.75, shadows: false, shadowSize: 512 },
};

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sun: THREE.DirectionalLight;
  private readonly clock = new THREE.Clock();

  private readonly city: CityLayout;
  private readonly player: PlayerController;
  private readonly avatar: Avatar;
  private readonly web = new WebLine();
  private readonly thwipWeb = new WebLine();
  /** Second strand for zip-to-point (one web from each hand). */
  private readonly zipWeb = new WebLine();
  private readonly zipFrom = new THREE.Vector3();
  private readonly zipTo = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly aimDir = new THREE.Vector3();
  /** Marker aim: camera direction (third person: raised a bit, like a crosshair above the hero). */
  private readonly markerDir = new THREE.Vector3();
  private readonly marker = new SwingMarker();
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly hud = new Hud();
  private readonly minimap: Minimap;
  private readonly arms = new FirstPersonArms(0xd23a3a);
  private readonly speedLines = new SpeedLines();
  private readonly thwipFrom = new THREE.Vector3();

  // Multiplayer.
  private readonly remotes: RemotePlayers;
  private readonly combat: CombatClient;
  private readonly shotHand = new THREE.Vector3();
  private readonly camRight = new THREE.Vector3();
  private readonly net: Network;
  private sendTimer = 0;
  private lastThwipCount = 0;
  private readonly netState: NetState = { p: [0, 0, 0], v: [0, 0, 0], y: 0, s: 0 };

  private accumulator = 0;
  private readonly renderPos = new THREE.Vector3();
  private readonly ropeDir = new THREE.Vector3();
  private readonly handPos = new THREE.Vector3();

  private frameBudget = 0;
  private lastTime = 0;
  private fpsAvg = 60;
  private worstFrameMs = 0;
  private hudTimer = 0;
  private contextLost = false;
  private noticeTimer = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    const sky = new THREE.Color(0x9fc4e8);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 250, 1400);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1600);

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x8a8f96, 1.6));
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -60;
    sc.right = sc.top = 60;
    sc.near = 1;
    sc.far = 1000;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    this.city = generateCity(WORLD_SEED);
    this.scene.add(buildCity(this.city));
    const collider = new CityCollider([...this.city.buildings, ...this.city.sidewalks]);

    this.player = new PlayerController(collider, this.city.halfX + 20, this.city.halfZ + 20);
    this.respawn();
    this.avatar = new Avatar(0xd23a3a);
    this.scene.add(this.avatar.root, this.web.mesh, this.thwipWeb.mesh, this.zipWeb.mesh, this.marker.sprite);

    this.remotes = new RemotePlayers(this.scene);
    this.net = new Network({
      welcome: (me, players, room, mode, hp) => {
        this.remotes.reset(players);
        this.combat.reset(mode, hp);
        this.avatar.setColor(me.color);
        this.arms.setColor(me.color);
        this.hud.setPlayerLabel(me.name, room);
      },
      join: (p) => this.remotes.add(p),
      leave: (id) => this.remotes.remove(id),
      state: (id, t, s) => this.remotes.pushState(id, t, s),
      event: (id, _t, e) => this.remotes.event(id, e),
      status: (status, message) => this.onNetStatus(status, message),
      game: (m) => this.combat.onMessage(m),
    });

    this.rig = new CameraRig(this.camera, collider);
    this.combat = new CombatClient(
      this.scene,
      collider,
      this.city,
      this.net,
      this.remotes,
      this.player,
      new CombatHud(),
      (amount) => this.rig.addTrauma(amount),
    );
    // First-person arms ride on the camera, so the camera must be in the scene.
    this.camera.add(this.arms.root);
    this.scene.add(this.camera);
    this.setView(this.hud.view);
    this.input = new Input(this.renderer.domElement);
    this.minimap = new Minimap(this.hud.minimapCanvas, this.city);

    this.applyQuality(this.hud.quality);
    this.precompileShaders();

    this.hud.onPlay((settings) => {
      this.rig.sensitivity = 0.003 * settings.sensitivity;
      this.input.rawMouse = settings.rawMouse;
      this.applyQuality(settings.quality);
      this.setView(settings.view);
      this.net.connect(settings.name, settings.room, settings.mode);
      this.input.requestLock();
    });
    this.input.onLockFailed = () =>
      this.hud.showNotice('The browser needs a second before it can capture the mouse again. Click Play/Resume again.');
    document.addEventListener('pointerlockchange', () => this.hud.setPlaying(this.input.locked));
    window.addEventListener('resize', () => this.onResize());

    // If the browser's graphics process resets, recover instead of dying.
    const canvas = this.renderer.domElement;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.hud.showNotice('Graphics reset by the browser. Recovering…');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.hud.showNotice(null);
    });
  }

  start(): void {
    this.renderer.setAnimationLoop((time) => this.loop(time));
  }

  /** Caps drawing at 60 FPS, also on 120/144 Hz screens. */
  private loop(time: number): void {
    const elapsed = this.lastTime ? time - this.lastTime : FRAME_MS;
    this.lastTime = time;
    this.frameBudget += elapsed;
    if (this.frameBudget < FRAME_MS - 2) return; // too soon: skip this screen refresh
    // Carry over a little (for 144 Hz pacing) but never enough to burst after a slow frame.
    this.frameBudget = Math.min(this.frameBudget - FRAME_MS, 8);
    if (this.contextLost) return;
    this.frame();
  }

  /** First or third person: swap the camera mode, hide the body or the arms. */
  private setView(view: View): void {
    this.rig.setMode(view);
    this.avatar.root.visible = view === 'third';
    this.arms.root.visible = view === 'first';
    this.hud.setView(view);
  }

  private onNetStatus(status: NetStatus, message?: string): void {
    if (status === 'rejected') this.hud.showNotice(message ?? 'The server refused the connection.');
    else if (status === 'connecting' && this.net.me) {
      // Lost an existing connection: others vanish until we're back.
      this.remotes.reset([]);
      this.hud.showNotice('Connection lost. Reconnecting…');
    } else if (status === 'online') this.hud.showNotice(null);
  }

  /** Send our movement ~20 times a second, plus one-shot events like thwips. */
  private sendNetwork(dt: number): void {
    if (this.net.status !== 'online') return;
    const p = this.player;
    if (p.thwipCount !== this.lastThwipCount) {
      this.lastThwipCount = p.thwipCount;
      this.net.sendEvent({ k: 'thwip', to: [p.thwipPoint.x, p.thwipPoint.y, p.thwipPoint.z] });
    }
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer += 1 / NET.sendRate;
    if (this.sendTimer < 0) this.sendTimer = 0;
    const s = this.netState;
    s.p = [p.pos.x, p.pos.y, p.pos.z];
    s.v = [p.vel.x, p.vel.y, p.vel.z];
    s.y = p.yaw;
    s.s = NET_STATES.indexOf(p.state);
    s.a = p.state === 'swing' || p.state === 'charge' || p.state === 'zip' ? [p.anchor.x, p.anchor.y, p.anchor.z] : undefined;
    s.w = p.state === 'wall' ? [p.wallNormal.x, p.wallNormal.z] : undefined;
    this.net.sendState(s);
  }

  private respawn(): void {
    const s = this.city.spawn;
    this.player.teleport(s.x, s.y + 1, s.z);
  }

  private applyQuality(q: Quality): void {
    const preset = QUALITY[q];
    this.renderer.setPixelRatio(preset.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.renderer.shadowMap.enabled !== preset.shadows) {
      this.renderer.shadowMap.enabled = preset.shadows;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) (Array.isArray(m) ? m : [m]).forEach((mat) => (mat.needsUpdate = true));
      });
    }
    if (this.sun.shadow.mapSize.x !== preset.shadowSize) {
      this.sun.shadow.mapSize.set(preset.shadowSize, preset.shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  /**
   * Build every shader up front. Otherwise the first web / marker / thwip
   * builds its shader mid-swing and the game hitches.
   */
  private precompileShaders(): void {
    const warmTag = new Nametag('warmup', 0xffffff);
    this.scene.add(warmTag.sprite);
    const hidden = [this.web.mesh, this.thwipWeb.mesh, this.zipWeb.mesh, this.marker.sprite, this.arms.root];
    hidden.forEach((o) => (o.visible = true));
    this.renderer.compile(this.scene, this.camera);
    hidden.forEach((o) => (o.visible = false));
    warmTag.sprite.removeFromParent();
    warmTag.dispose();
  }

  private frame(): void {
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.1);
    const { input, player } = this;

    const { dx, dy } = input.takeMouseDelta();
    this.rig.rotate(dx, dy);
    if (input.consume('respawn') && !player.frozen) this.respawn();
    if (input.consume('view')) {
      const next = this.rig.mode === 'first' ? 'third' : 'first';
      this.setView(next);
      this.hud.showNotice(`${next === 'first' ? 'First' : 'Third'} person (${bindingName('view')} to switch)`);
      this.noticeTimer = 1.5;
    }
    if (this.noticeTimer > 0 && (this.noticeTimer -= dt) <= 0) this.hud.showNotice(null);
    // Combat buttons: left-click shoots; C + left-click is a zip strike; E yanks.
    const anchorDown = input.down('anchor');
    const attackPressed = input.consume('attack');
    const combatInput = {
      fireHeld: input.down('attack') && !anchorDown,
      strikePressed: attackPressed && anchorDown,
      yankPressed: input.consume('yank'),
    };

    this.camera.getWorldDirection(this.aimDir);
    // First person: the marker aims exactly where you look. Third person: the
    // controller derives the aim from your look direction (yaw/pitch), since
    // the camera is framed above the hero.
    const fpAim = this.rig.mode === 'first';
    this.markerDir.copy(this.aimDir);
    this.accumulator += dt;
    while (this.accumulator >= FIXED_DT) {
      player.step(
        {
          moveX: (input.down('right') ? 1 : 0) - (input.down('left') ? 1 : 0),
          moveZ: (input.down('forward') ? 1 : 0) - (input.down('back') ? 1 : 0),
          sprint: input.down('sprint'),
          jumpPressed: input.consume('jump'),
          swingHeld: input.down('swing'),
          swingPressed: input.consume('swing'),
          camYaw: this.rig.yaw,
          camPitch: this.rig.pitch,
          thwipPressed: input.consume('thwip'),
          anchorHeld: input.down('anchor'),
          aimDir: this.aimDir,
          markerOrigin: fpAim ? this.camera.position : undefined,
          markerDir: fpAim ? this.markerDir : undefined,
        },
        FIXED_DT,
      );
      this.accumulator -= FIXED_DT;
    }

    // Safety net: if the physics ever produced an invalid number, respawn
    // instead of freezing or rendering garbage.
    const p = player.pos;
    const v = player.vel;
    if (!Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z)) {
      console.warn('Physics produced an invalid value; respawning.', p.toArray(), v.toArray());
      this.respawn();
    }

    // Smooth rendering between physics steps.
    this.renderPos.lerpVectors(player.prevPos, player.pos, this.accumulator / FIXED_DT);

    // Camera first (first-person arms and webs hang off it).
    const speed = player.vel.length();
    this.rig.addTrauma(player.jolt);
    player.jolt = 0;
    if (this.hud.hasEntered) this.rig.update(this.renderPos, player.vel, dt);
    else this.attractCamera(dt); // home screen: slow flight over the skyline
    this.camera.updateMatrixWorld();
    const firstPerson = this.rig.mode === 'first';

    // Left-arm punch for thwips and web shots (whichever was most recent).
    const shotNewer = this.combat.shotAge < player.thwipAge;
    const punchAge = Math.min(player.thwipAge, this.combat.shotAge);
    const punchPoint = shotNewer ? this.combat.shotPoint : player.thwipPoint;
    const downed = player.downTime > 0 || player.frozen;

    // Web strand to the anchor while swinging, charging a launch, or zipping.
    const swinging = player.state === 'swing' || player.state === 'charge' || player.state === 'zip';
    if (swinging) this.ropeDir.subVectors(player.anchor, this.renderPos).normalize();
    if (firstPerson) {
      this.arms.update(
        this.camera,
        {
          state: player.state,
          anchor: swinging ? player.anchor : null,
          thwipAge: punchAge,
          thwipPoint: punchPoint,
          speed,
          moving: player.state === 'ground' && Math.hypot(player.vel.x, player.vel.z) > 1,
        },
        dt,
      );
      this.arms.rightHandWorld(this.handPos);
      this.arms.leftHandWorld(this.thwipFrom);
    } else {
      this.avatar.update(
        this.renderPos,
        player.yaw,
        swinging ? this.ropeDir : null,
        player.state === 'wall' ? player.wallNormal : null,
        player.vel,
        dt,
        player.state === 'charge',
        punchAge,
        downed,
      );
      if (swinging) this.handPos.copy(this.renderPos).addScaledVector(this.ropeDir, 1.9);
      if (player.state === 'charge') this.handPos.set(this.renderPos.x + 0.1, this.renderPos.y + 1.85, this.renderPos.z); // raised hand while crouched
      this.thwipFrom.set(this.renderPos.x, this.renderPos.y + 1.5, this.renderPos.z);
    }
    // Zip-to-point fires two webs, one from each hand, landing side by side.
    const zipping = player.state === 'zip';
    if (zipping) {
      this.side.crossVectors(this.ropeDir, this.camera.up).normalize();
      if (firstPerson) this.arms.leftHandWorld(this.zipFrom);
      else {
        this.zipFrom.copy(this.handPos).addScaledVector(this.side, -0.6);
        this.handPos.addScaledVector(this.side, 0.15);
      }
      this.zipTo.copy(player.anchor).addScaledVector(this.side, -0.6);
    }
    this.zipWeb.update(this.zipFrom, zipping ? this.zipTo : null);
    this.web.update(this.handPos, swinging ? player.anchor : null);
    // Thwip strand: visible for a split second after firing.
    this.thwipWeb.update(this.thwipFrom, player.thwipAge < 0.18 ? player.thwipPoint : null);

    // Combat: web shots leave from the left (punching) hand.
    if (firstPerson) this.arms.leftHandWorld(this.shotHand);
    else {
      this.camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
      this.shotHand.set(this.renderPos.x, this.renderPos.y + 1.45, this.renderPos.z).addScaledVector(this.camRight, -0.4);
    }
    this.combat.update(dt, combatInput, this.camera, this.shotHand);

    // Marker is "ready" when a click would do something: in the air, or on the ground with C held.
    const anchorHeld = input.down('anchor');
    const markerReady = player.state !== 'ground' || anchorHeld;
    this.marker.update(
      player.hasTarget && player.state !== 'zip' ? player.target : null,
      !markerReady ? 'idle' : anchorHeld ? 'anchor' : 'ready',
      dt,
    );
    this.hud.setLaunchCue(player.state === 'zip' && player.zipLaunchQueued ? (player.zipToRoof ? 'LAUNCH!' : 'BOUNCE!') : null);
    this.hud.setCharge(player.state === 'charge' ? player.chargeTime : null);
    this.speedLines.update(speed, dt);

    // Shadows follow the player.
    this.sun.position.set(this.renderPos.x + 240, this.renderPos.y + 400, this.renderPos.z + 160);
    this.sun.target.position.copy(this.renderPos);

    this.sendNetwork(dt);
    this.remotes.update(this.net.serverNow(), dt, this.camera);

    this.minimap.draw(this.renderPos.x, this.renderPos.z, this.rig.yaw, player.yaw, this.remotes.markers());
    this.renderer.render(this.scene, this.camera);

    // Stats: average FPS and the worst frame recently (spikes = hitches).
    this.fpsAvg += (1 / Math.max(rawDt, 1e-3) - this.fpsAvg) * 0.05;
    this.worstFrameMs = Math.max(this.worstFrameMs, rawDt * 1000);
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.5;
      this.hud.setStats({
        fps: Math.round(this.fpsAvg),
        spike: `${Math.round(this.worstFrameMs)} ms`,
        mouse: `${input.eventsPerSecond()} ev/s`,
        speed: `${speed.toFixed(1)} m/s`,
        height: `${player.pos.y.toFixed(1)} m`,
        state: player.state,
        chain: player.chain,
        release: releaseLabel(player.lastReleaseQuality),
        thwip: player.thwipCooldownLeft > 0 ? `${player.thwipCooldownLeft.toFixed(1)} s` : player.pos.y < THWIP.minHeight ? `below ${THWIP.minHeight} m` : 'ready',
        net: this.netLabel(),
      });
      this.worstFrameMs = 0;
    }
  }

  private netLabel(): string {
    switch (this.net.status) {
      case 'online':
        return `${this.remotes.count + 1} in "${this.net.room}" · ${Math.round(this.net.rtt)} ms`;
      case 'connecting':
        return 'connecting…';
      case 'rejected':
        return 'refused';
      default:
        return 'offline';
    }
  }

  /** Home-screen backdrop: a slow orbit around the skyscraper district. */
  private attractTime = 0;
  private attractCamera(dt: number): void {
    this.attractTime += dt;
    const t = this.attractTime * 0.04 + 0.6;
    const cx = this.city.spawn.x - 20;
    const cz = this.city.spawn.z - 40;
    const r = 240;
    this.camera.position.set(cx + Math.cos(t) * r, 120 + Math.sin(t * 0.7) * 25, cz + Math.sin(t) * r);
    this.camera.lookAt(cx, 70, cz);
    if (this.camera.fov !== 55) {
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
    }
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

function releaseLabel(q: number): string {
  if (q >= 0.85) return 'PERFECT';
  if (q >= 0.5) return 'good';
  if (q > 0) return 'ok';
  return '-';
}
