import * as THREE from 'three';
import { CityCollider, WORLD_SEED, generateCity, type CityLayout } from '@game/shared';
import { Input } from './Input';
import { PlayerController } from './PlayerController';
import { CameraRig } from './CameraRig';
import { Avatar } from './Avatar';
import { WebLine } from './WebLine';
import { SwingMarker } from './SwingMarker';
import { FirstPersonArms } from './FirstPersonArms';
import { SpeedLines } from '../ui/SpeedLines';
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
  private readonly marker = new SwingMarker();
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly hud = new Hud();
  private readonly minimap: Minimap;
  private readonly arms = new FirstPersonArms(0xd23a3a);
  private readonly speedLines = new SpeedLines();
  private readonly thwipFrom = new THREE.Vector3();

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

    this.rig = new CameraRig(this.camera, collider);
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
    const hidden = [this.web.mesh, this.thwipWeb.mesh, this.zipWeb.mesh, this.marker.sprite, this.arms.root];
    hidden.forEach((o) => (o.visible = true));
    this.renderer.compile(this.scene, this.camera);
    hidden.forEach((o) => (o.visible = false));
  }

  private frame(): void {
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.1);
    const { input, player } = this;

    const { dx, dy } = input.takeMouseDelta();
    this.rig.rotate(dx, dy);
    if (input.consume('respawn')) this.respawn();
    if (input.consume('view')) {
      const next = this.rig.mode === 'first' ? 'third' : 'first';
      this.setView(next);
      this.hud.showNotice(next === 'first' ? 'First person (V to switch)' : 'Third person (V to switch)');
      this.noticeTimer = 1.5;
    }
    if (this.noticeTimer > 0 && (this.noticeTimer -= dt) <= 0) this.hud.showNotice(null);
    input.consume('attack'); // reserved for combat; drop presses for now

    this.camera.getWorldDirection(this.aimDir);
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
    this.rig.update(this.renderPos, player.vel, dt);
    this.camera.updateMatrixWorld();
    const firstPerson = this.rig.mode === 'first';

    // Web strand to the anchor while swinging, charging a launch, or zipping.
    const swinging = player.state === 'swing' || player.state === 'charge' || player.state === 'zip';
    if (swinging) this.ropeDir.subVectors(player.anchor, this.renderPos).normalize();
    if (firstPerson) {
      this.arms.update(
        this.camera,
        {
          state: player.state,
          anchor: swinging ? player.anchor : null,
          thwipAge: player.thwipAge,
          thwipPoint: player.thwipPoint,
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
        player.thwipAge,
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

    // Marker is "ready" when a click would do something: in the air, or on the ground with C held.
    const markerReady = player.state !== 'ground' || input.down('anchor');
    this.marker.update(player.hasTarget && player.state !== 'zip' ? player.target : null, markerReady, dt);
    this.hud.setCharge(player.state === 'charge' ? player.chargeTime : null);
    this.speedLines.update(speed, dt);

    // Shadows follow the player.
    this.sun.position.set(this.renderPos.x + 240, this.renderPos.y + 400, this.renderPos.z + 160);
    this.sun.target.position.copy(this.renderPos);

    this.minimap.draw(this.renderPos.x, this.renderPos.z, this.rig.yaw, player.yaw);
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
      });
      this.worstFrameMs = 0;
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
