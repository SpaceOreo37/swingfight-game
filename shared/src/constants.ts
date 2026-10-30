/** Seed for the city. Multiplayer will send this from the server instead. */
export const WORLD_SEED = 1337;

/** Movement tuning. Units are meters, seconds, kilograms. */
export const PHYS = {
  /**
   * About 2x Earth gravity. Real gravity (9.81) at city scale feels floaty;
   * action games exaggerate it so arcs are snappy. Every force uses this.
   */
  gravity: 20,
  /** Extra gravity while rising through the air (not swinging): upward flings keep their speed but arc over sooner. */
  riseGravityScale: 1.25,
  radius: 0.4,
  height: 1.8,
  stepHeight: 0.5,
  runSpeed: 9,
  sprintSpeed: 17,
  groundAccel: 70,
  groundFriction: 50,
  /** Superhuman jumps: ~2.6m normal, ~4m sprinting (with rise gravity). */
  jumpSpeed: 11.5,
  sprintJumpSpeed: 14,
  airAccel: 14,
  airMaxSpeed: 12,
};

/**
 * Air resistance: drag force = 0.5 * airDensity * dragArea * speed^2.
 * With these numbers terminal velocity is ~71 m/s (a head-down skydiver hits 70-80).
 */
export const AIR = {
  mass: 80,
  airDensity: 1.225,
  /** Drag coefficient x frontal area (m^2). ~0.25 is a streamlined, head-first diving pose. */
  dragArea: 0.25,
};
/** Drag deceleration per (m/s)^2 of speed. */
export const DRAG_K = (0.5 * AIR.airDensity * AIR.dragArea) / AIR.mass;

/** Web-swing tuning. */
export const SWING = {
  // --- Aiming: where the marker looks for a web point ---
  /** Standing / slow: ideal web point is this far ahead of the player... */
  ahead: 12,
  /** ...and this far above. */
  up: 14,
  /**
   * Moving: the ideal web point is at a right angle to your velocity (a web
   * that's tight the moment it attaches), this far away...
   */
  ropeLength: 20,
  /** ...plus this much per m/s of speed (faster = longer, wider arcs). */
  ropePerSpeed: 0.3,
  /** Never aim lower than this much "up" in the web direction (0-1). */
  minUpTilt: 0.55,
  /** Looking up/down moves the ideal point up/down by up to this much. */
  lookRange: 14,
  searchRadius: 34,
  /** Web point must be at least this far above the player. */
  minAnchorHeight: 4,
  minDist: 8,
  maxDist: 60,
  /** Zip-to-point (C held): closest, farthest, and how far below you an edge can be (m). */
  zipMinDist: 2.5,
  zipMaxDist: 80,
  zipMaxDrop: 50,
  /** Third person aims this much (radians) above the camera's center, like a crosshair over the character. */
  aimRaise: 0.3,
  /** Swinging aims this much higher than where you look (radians); zipping (C) aims exactly. */
  swingAimLift: 0.5,
  /** When aiming (slow, or holding C), ignore edges further than this from the aim (radians). */
  maxAimAngle: 0.8,
  /** At high speed, up to this much of the choice comes from the physics-friendly spot (0-1). */
  physicsBlendMax: 0.7,
  /** Keeps the marker from flickering between two similar points (lower = stickier). */
  stickiness: 0.7,

  // --- Physics ---
  /** When a web attaches it snaps tight: this much speed toward the anchor (m/s). */
  attachTug: 3,
  /** Small sideways force from leaning your body (m/s^2). */
  steer: 4,
  /**
   * The hero pulls the web in near the bottom of each arc, like pumping a
   * playground swing. Angular momentum is conserved, so a shorter web
   * means a faster spin: every swing makes you faster.
   */
  reelSpeed: 8,
  /** Max fraction of the web pulled in per swing. */
  reelFraction: 0.3,
  /**
   * Swing chains build rhythm: each swing in a row (without touching the
   * ground) pulls this much more of the web in, up to chainBonusMax swings.
   */
  chainBonus: 0.04,
  chainBonusMax: 6,
  /** Only pull in the lower part of the arc (1 = straight below the anchor). */
  reelZone: 0.5,
  minRope: 6,
  /**
   * Web elasticity, per kg of hero (N/m/kg). Spider silk stretches a lot, so
   * the web catches you like a stiff bungee and gives the energy back.
   */
  webStiffness: 90,
  /** Web damping (1/s): stops the bungee from bouncing forever. */
  webDamping: 3,
  /** Max stretch as a fraction of web length before it goes rigid. */
  maxStretch: 0.15,
  /** The web shortens if needed so the bottom of the arc stays this high above the street. */
  groundClearance: 5,
  /** Safety cap only. Drag is what normally limits speed. */
  maxSpeed: 80,
  /** Jump mid-swing: one hard yank on the web toward the anchor, then let go. */
  yankSpeed: 8,
  /**
   * Release boost (game-style, like Spider-Man 2): let go on the upswing near
   * this many degrees past straight down for a push along your direction of travel.
   */
  perfectReleaseAngle: 35,
  /** How far off the perfect angle still gives some boost (degrees). */
  releaseWindow: 30,
  /** Boost (m/s) for a perfect release; scales down to 0 at the edge of the window. */
  releaseBoost: 5,
  /** Delay after letting go before another web can fire. */
  cooldown: 0.15,
  /**
   * Swing assist: how much a web on a building to the side of where you're
   * LOOKING pulls you sideways (1 = fully real). Low = straight swings down
   * the street. Turn the camera toward a side street and the corner web
   * counts as "ahead", so it pulls you around the corner.
   */
  lateralPull: 0.05,
  /** How much your travel direction (vs. where you look) picks the next web point, at speed (0-1). Lower = the camera steers more. */
  travelWeight: 0.3,
};

/** Web thwip (Tab): a quick web that yanks you horizontally toward where you're looking (never upward). */
export const THWIP = {
  /** Horizontal speed added on top of your current horizontal speed (m/s). */
  boost: 12,
  /** Even from a standstill, you leave at least this fast (horizontally). */
  minSpeed: 14,
  /** Seconds between thwips. */
  cooldown: 2.5,
  /** Only works at least this high above the street (m). */
  minHeight: 10,
  /** How far the web reaches if it doesn't hit a building (just for the visual). */
  reach: 40,
};

/** Wall running / climbing. Automatic: hit a wall while moving into it and you stick. */
export const WALL = {
  /** Running straight up (push toward the wall). */
  climbSpeed: 12,
  sprintClimbSpeed: 18,
  /** Running sideways along the wall. */
  runSpeed: 14,
  sprintRunSpeed: 20,
  /** How fast your speed changes toward what you're pressing (m/s^2). Lower = momentum lasts longer. */
  accel: 22,
  /** With no input you slowly slide down. */
  slideSpeed: 2,
  /** Fraction of the speed you hit the wall with that turns into upward run. */
  impactToUp: 0.85,
  maxEntrySpeed: 45,
  /** Air: grab the wall if pushing toward it at least this much (0-1)... */
  grabInput: 0.3,
  /** ...or flying into it at least this fast (m/s). */
  grabSpeed: 4,
  /** Ground: walk into a wall (this much toward it) to start climbing. */
  groundGrabInput: 0.7,
  /** Wall jump: push off the wall and up. */
  jumpOut: 11,
  jumpUp: 10,
  /** Reaching the top: hop up and onto the roof. */
  vaultUp: 7,
  vaultPush: 6,
  /** Seconds after leaving a wall before you can grab one again. */
  cooldown: 0.35,
};

/** Anchor key (C) + web: a charged launch from the ground, or zip-to-point in the air. */
export const LAUNCH = {
  /** Launch speed at full power (m/s). */
  maxSpeed: 55,
  /** Even a tap gives this much. */
  minSpeed: 8,
  /**
   * The launch flies toward the web point, aimed like a thrown ball so the
   * arc passes this far above the point (m), landing you right at the edge.
   */
  aimAbove: 1.5,
  /** Charge curve (seconds held): 0..rampStart weak, rampStart..fullAt ramps up, fullAt..overchargeAt max, after that overcharged. */
  rampStart: 1,
  fullAt: 3,
  overchargeAt: 4,
  /** Power before the ramp starts (fraction of max). */
  weakPower: 0.2,
  /** Power when held too long (fraction of max). */
  overchargePower: 0.5,
  /** Seconds after a launch before you can stick to a wall (so you don't grab the wall you started next to). */
  noWallGrab: 0.3,
  /** Zip strike (C + left-click at a player): speed, give-up time, and how close counts as a hit. */
  strikeSpeed: 65,
  strikeMaxTime: 1.6,
  strikeConnect: 2.2,
  /** Zip-to-point travel speed (m/s). */
  zipSpeed: 55,
  /** Give up on a zip after this long (something in the way). */
  zipMaxTime: 3,
  /** Pop at the end of a zip that lands on a roof: up and inward (m/s). */
  zipPopUp: 7,
  zipPopIn: 7,
  /**
   * Point launch: press Space during a zip to a roof edge and you get flung
   * up and onward from the edge instead of landing (m/s).
   */
  pointLaunchSpeed: 42,
  /** The launch always points at least this much upward (0-1) so you clear the edge. */
  pointLaunchMinUp: 0.45,
  /**
   * Wall bounce: press Space during a zip that ends on a wall and you reflect
   * off it like a ball (angle in = angle out), at this fraction of zip speed.
   */
  wallBounceSpeedScale: 0.8,
  /** A Space press up to this long AFTER arriving still counts (s). */
  pointLaunchGrace: 0.2,
};

/** Launch power (0..1) for a charge held this many seconds. */
export function launchPower(t: number): number {
  const L = LAUNCH;
  if (t > L.overchargeAt) return L.overchargePower;
  if (t >= L.fullAt) return 1;
  if (t >= L.rampStart) return L.weakPower + ((1 - L.weakPower) * (t - L.rampStart)) / (L.fullAt - L.rampStart);
  return (L.weakPower * t) / L.rampStart;
}

/** Camera feel: shake, G-force lag, speed effects. */
export const CAMERA_FX = {
  /** Shake fades by this much per second (trauma 0..1). */
  shakeDecay: 1.6,
  /** Max shake offset (m) and roll (radians) at full trauma. */
  shakeMove: 0.22,
  shakeRoll: 0.035,
  /** Constant rumble starts at this speed (m/s) and is full at speed + range. */
  rumbleFrom: 22,
  rumbleRange: 40,
  rumbleMax: 0.35,
  /** Camera lags behind sudden acceleration: meters per m/s^2, capped. */
  lagPerAccel: 0.012,
  lagMax: 1.4,
  /** FOV: base, extra at high speed, and a quick kick on sudden boosts. */
  fov: 70,
  fovSpeedExtra: 12,
  fovKickPerAccel: 0.06,
  fovKickMax: 8,
};
