# The Swingfight Game

Browser-based open-city web-swinging game, built in small steps. Mechanics first, graphics later, then multiplayer fights with friends.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN IP)
```

Enter a name, click **Play**.

| Input | Action |
|---|---|
| WASD | move (relative to camera) |
| Shift | sprint |
| Space | jump · jump off a swing for a boost |
| Right-click (hold) | web swing (in the air) at the marker. Keep holding to chain swings |
| Tab | web thwip: yank toward where you're looking (keeps your speed + a little) |
| C + right-click (ground) | charge a launch: web planted, meter fills. Release right-click or C to launch, mostly straight up. Power: 0–1s weak, 1–3s ramps up, **3–4s max**, over 4s drops to half |
| C + right-click (air / wall) | zip to the marker point: lands you on top of a roof edge, or sticks you to the wall at a corner partway up |
| Walls | run, jump or swing into one to stick. Push toward it = climb, sideways = run along, away = drop, Space = wall-jump. You vault onto the roof at the top |
| V | switch first / third person (also in the menu) |
| Left-click | attack (reserved for combat) |
| R | respawn |
| Esc | menu (name, mouse sensitivity) |

All bindings live in [client/src/game/Controls.ts](client/src/game/Controls.ts). Swinging is on right-click so left-click stays free for attacks. That way you can fight mid-swing without the two fighting over a button.

## Layout

```
shared/   Code both the browser and a future server use
  city.ts        Seeded city generator (same seed = same map for everyone)
  collision.ts   Box collision + raycasts over a spatial grid
  constants.ts   All movement + swing tuning numbers (PHYS, SWING)
client/   The browser game (Vite + TypeScript + Three.js)
  game/Game.ts              Main loop: fixed 60Hz physics, render, HUD, dynamic resolution
  game/PlayerController.ts  Movement states: ground / air / swing
  game/Controls.ts          Key bindings
  game/CameraRig.ts         Third-person camera that avoids walls
  game/CityRenderer.ts      City meshes, merged per 128m chunk
  game/Avatar.ts, WebLine.ts  Placeholder character + web strand
  ui/Hud.ts, ui/Minimap.ts  Start screen, stats, rotating minimap
```

## How swinging works

Physics first, plus a few deliberate game-style assists:

- **Forces:** gravity (2x Earth, like action games use, and a little extra while rising through the air), real air drag for a streamlined person, and a stretchy spider-silk web (Hooke's law with damping) that pulls but never pushes, and can go slack.
- **Aim marker:** a diamond snaps to the building edge or corner your web will hit. Slow, it follows where you look. Moving, it picks a point that makes the web tight the instant it attaches. Look up or down to shift it. Faded = on the ground, bright = ready.
- **One web per click, air only.** Click while airborne, or hold right-click and jump: it fires as you leave the ground.
- **The web stays on until you let go of right-click.** Hold past the top and you swing back like a real pendulum.
- **Release = momentum.** You leave with exactly the speed and direction you had at that moment: at the bottom you fly forward, on the upswing you fly up (and gravity pulls harder while rising).
- **Release timing boost (game-style, like Spider-Man 2):** letting go on the upswing near 35° past the bottom adds up to +5 m/s. The HUD shows `release: PERFECT / good / ok`.
- **Faster every swing:** near the bottom of each arc the hero pulls the web in, like pumping a playground swing (a shorter web spins you faster). Each swing in a chain pulls a little harder.
- **Space mid-swing:** a hard yank on the web, then let go.
- **Assists:** a web on a building beside you pulls you sideways at only 35% strength (so you go down the street, not into the wall), and the web shortens automatically so your arc clears the street.

All numbers are in `PHYS`, `AIR` and `SWING` in [shared/src/constants.ts](shared/src/constants.ts).

## Staying lightweight as the city gets dense

What's in place now:
- **No downloaded assets.** The city and window textures are generated in code, so the whole game is about 136 KB gzipped. Three.js is a separate file so it stays cached between updates.
- **Chunked city.** Buildings are merged into one mesh per 128m chunk: few draw calls, and chunks off-screen or outside the shadow area are skipped.
- **No hidden faces.** Building bottoms are never drawn.
- **Dynamic resolution.** If FPS drops below ~50, the game renders fewer pixels until it recovers. Pixel ratio is capped at 1.5.
- **Cheap HUD.** The minimap is drawn once and only rotated/cropped each frame. Stats update 4× a second.

Plan for when the city gets dense (props, cars, people, detailed buildings):
- **Instancing** (InstancedMesh / BatchedMesh) for anything repeated: lamps, cars, AC units, windows as geometry.
- **LOD per chunk:** detailed meshes up close, simple boxes far away, and fog to hide the cutoff.
- **Stream chunks:** build or load nearby chunks only, generating them in a Web Worker so the main thread never stutters.
- **Compressed assets** when real models arrive: glTF with meshopt/Draco geometry and KTX2 textures (smaller downloads and less GPU memory).
- **Shadow budget:** a tight shadow area around the player, with baked lighting for the far city.

## Game feel

- **Camera shake:** a rumble that grows with speed, plus kicks from web catches, launches, thwips, wall impacts, hard landings and zip arrivals (`jolt` in the controller → `CameraRig.addTrauma`).
- **G-forces:** the camera lags behind sudden acceleration and catches up. The FOV widens with speed and kicks on boosts.
- **Web tug:** a web snaps tight when it attaches.
- **Wind:** speed lines and a vignette that scale with speed (2D overlay, half resolution).
- **First person:** camera in the head, arms drawn on top of the world. The web arm reaches for the anchor while swinging, the other arm punches out on thwip, arm raised while charging, both reaching on a zip, hands climbing on walls.
- **The body always faces where the mouse looks,** which also suits combat.

All camera numbers are in `CAMERA_FX` in [shared/src/constants.ts](shared/src/constants.ts).

## The city

Generated from a seed in a few milliseconds, with no downloads:

- About 1.2 km × 1.2 km on an island. Long blocks between wide avenues (north–south) and narrower cross streets, like a real downtown grid.
- Two skyscraper districts (towers up to ~290m with setbacks and spires), brick and concrete low-rises around them, a large central park, and small parks.
- Four facade styles (glass, office, brick, concrete) plus gravel roofs, all in one shared texture. A small shader tweak picks the right tile, so each 192m chunk of buildings is still one draw call.
- Instanced detail: ~1,400 street lights, ~2,300 rooftop AC units, ~400 water towers, park trees. Lane lines and crosswalks are one merged mesh.

## Roadmap (one step at a time)

1. ✅ **Basics:** project setup, city map, walk/sprint/jump, camera
2. ✅ **Web swinging, name, minimap, perf pass** ← test & tune this
3. ✅ **Bigger, more realistic city + wall running/climbing** (zip to point, corner wraps: later)
4. **Multiplayer:** Node WebSocket server, see friends move + their names
5. **Combat (PvP):** melee on left-click, dodge, web shots, health, server-checked hits
6. **Feel polish:** animations, camera effects, gamepad, sound
7. **Graphics upgrade:** real models, lighting, post-processing
