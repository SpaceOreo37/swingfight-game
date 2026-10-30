/**
 * Every key/button binding in one place. Mouse buttons are 'Mouse0' (left),
 * 'Mouse1' (middle), 'Mouse2' (right).
 *
 * Layout plan (with PvP combat in mind):
 *   Left click   web shot at the crosshair (hold to keep firing)
 *   C + left     zip strike at the player under the crosshair
 *   E            yank the player under the crosshair to the floor
 *   Right click  web swing (hold). Traversal stays on its own button.
 *   Space        jump / jump off a swing for a boost
 *   Tab          web thwip: yank toward where you're looking
 *   C (hold)     anchor: + right-click on the ground = charged launch,
 *                in the air = zip to the marker point
 *   Shift        sprint (later: parkour / wall-run)
 *   Q            dodge (later)
 *   F            ranged web shot (later)
 *   V            switch first / third person
 */
export const BINDINGS = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  swing: ['Mouse2'],
  thwip: ['Tab'],
  anchor: ['KeyC'],
  attack: ['Mouse0'],
  yank: ['KeyE'],
  respawn: ['KeyR'],
  view: ['KeyV'],
} as const;

export type Action = keyof typeof BINDINGS;
