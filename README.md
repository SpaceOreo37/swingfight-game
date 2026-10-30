# The Swingfight Game

Browser-based open-city web-swinging game, built in small steps. Mechanics first, graphics later, then multiplayer fights with friends.

## Run it

```bash
npm install
npm run dev        # game server (:3001) + game (:5173), both auto-reload
npm test           # server + networking tests
```

Open http://localhost:5173. Production-style (one port serves everything): `npm start` → http://localhost:3001.

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
| Space during a zip to a roof edge | point launch: instead of landing, get flung up and onward off the edge |
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
  protocol.ts    Every network message + validation (bump PROTOCOL_VERSION on changes)
server/   Node WebSocket game server (rooms, validation, 20 Hz broadcast) + tests
client/   The browser game (Vite + TypeScript + Three.js)
  game/Game.ts              Main loop: fixed 60Hz physics, render, HUD, dynamic resolution
  game/PlayerController.ts  Movement states: ground / air / swing
  game/Controls.ts          Key bindings
  game/CameraRig.ts         Third-person camera that avoids walls
  game/CityRenderer.ts      City meshes, merged per 128m chunk
  game/Avatar.ts, WebLine.ts  Placeholder character + web strand
  ui/Hud.ts, ui/Minimap.ts  Start screen, stats, rotating minimap
  net/Network.ts            Connection, reconnect, clock sync
  net/SnapshotBuffer.ts     Smooth interpolation of other players (tested)
  net/RemotePlayers.ts      Drawing other players, their webs and name tags
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

## Multiplayer

**Playing with friends**
- Everyone in the same **room** sees each other. Type a room name in the menu, or send a link like `http://<your-ip>:5173/?room=crew`.
- **Same Wi-Fi:** friends open `http://<your computer's IP>:5173` (shown as "Network" when `npm run dev` starts).
- **Over the internet:** run a tunnel to port 5173 (e.g. `cloudflared tunnel --url http://localhost:5173`) and share its link, or deploy the server (`npm start` serves the game and the socket on one port).

**How it works**
- **Client-authoritative movement, server-checked.** Each client simulates itself and sends its state 20×/s. The server rejects malformed or impossible states (outside the city, faster than 120 m/s) and broadcasts each room at a fixed 20 Hz.
- **Smooth remote players.** Clients draw others ~110 ms in the past, blending snapshots with a curve that matches their velocity (`client/src/net/SnapshotBuffer.ts`). Teleports snap, late packets get a brief prediction, and a clock sync (ping/pong, lowest-RTT samples) keeps timing aligned.
- **Events** (`NetEvent`) carry one-shot effects like thwips. Attacks will use the same channel.
- **Combat-ready:** the server keeps 1 s of position history per player for lag-compensated hit checks later.
- **Resilience:**
  - auto-reconnect with backoff
  - "refresh" message if versions differ
  - per-player rate limiting (flooders get kicked)
  - idle timeout
  - rooms are isolated, and a crash in one message handler can't take the server down
- **Name tags** float above other players (never your own), keep a readable size at any distance, and show through walls so friends are easy to find (`THROUGH_WALLS` in `Nametag.ts`).

**Rules for changing it (so nothing breaks)**
1. All messages live in `shared/src/protocol.ts`. **Change a message shape → bump `PROTOCOL_VERSION`.**
2. Every incoming message goes through `parseClientMessage` / `parseServerMessage`. Add validation for new fields there.
3. Add a test in `server/test/server.test.ts` for any new message, and run `npm test`.

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
4. ✅ **Multiplayer foundation:** rooms, smooth remote players, name tags, minimap dots, tests
5. **Combat (PvP):** melee on left-click, dodge, web shots, health, server-checked hits
6. **Feel polish:** animations, camera effects, gamepad, sound
7. **Graphics upgrade:** real models, lighting, post-processing
