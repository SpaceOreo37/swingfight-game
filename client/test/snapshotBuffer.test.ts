import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NET, type NetState } from '@game/shared';
import { SnapshotBuffer, lerpAngle } from '../src/net/SnapshotBuffer';

const st = (x: number, vx = 0, extra: Partial<NetState> = {}): NetState => ({ p: [x, 0, 0], v: [vx, 0, 0], y: 0, s: 1, ...extra });
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

describe('SnapshotBuffer', () => {
  it('returns null until something arrives', () => {
    assert.equal(new SnapshotBuffer().sample(100), null);
  });

  it('blends between snapshots, matching them exactly at their times', () => {
    const b = new SnapshotBuffer();
    b.push(0, st(0, 10));
    b.push(100, st(1, 10));
    near(b.sample(0)!.p[0], 0);
    near(b.sample(50)!.p[0], 0.5); // constant velocity -> straight line
    near(b.sample(100)!.p[0], 1);
  });

  it('follows velocity smoothly (cubic), not a straight zig-zag', () => {
    const b = new SnapshotBuffer();
    // Moving up then coming down: the midpoint should bulge above the straight line.
    b.push(0, { p: [0, 0, 0], v: [0, 10, 0], y: 0, s: 1 });
    b.push(200, { p: [0, 0, 0], v: [0, -10, 0], y: 0, s: 1 });
    assert.ok(b.sample(100)!.p[1] > 0.4);
  });

  it('handles out-of-order and duplicate packets', () => {
    const b = new SnapshotBuffer();
    b.push(100, st(1));
    b.push(0, st(0));
    b.push(100, st(1));
    b.push(200, st(2));
    assert.equal(b.size, 3);
    near(b.sample(150)!.p[0], 1.5, 0.2);
  });

  it('predicts briefly past the newest snapshot, then holds', () => {
    const b = new SnapshotBuffer();
    b.push(0, st(0, 10));
    near(b.sample(100)!.p[0], 1);
    const capped = (NET.maxExtrapolateMs / 1000) * 10;
    near(b.sample(10_000)!.p[0], capped);
  });

  it('snaps on teleports (respawn) instead of sliding across the map', () => {
    const b = new SnapshotBuffer();
    b.push(0, st(0));
    b.push(100, st(500));
    assert.equal(b.sample(25)!.p[0], 0);
    assert.equal(b.sample(75)!.p[0], 500);
  });

  it('switches discrete state and web anchor at the halfway point', () => {
    const b = new SnapshotBuffer();
    b.push(0, st(0, 0, { s: 1 }));
    b.push(100, st(0, 0, { s: 2, a: [5, 5, 5] }));
    assert.equal(b.sample(40)!.s, 1);
    assert.equal(b.sample(40)!.a, undefined);
    assert.equal(b.sample(60)!.s, 2);
    assert.deepEqual(b.sample(60)!.a, [5, 5, 5]);
  });

  it('keeps memory bounded', () => {
    const b = new SnapshotBuffer();
    for (let i = 0; i < 1000; i++) b.push(i * 50, st(i));
    assert.ok(b.size <= 40);
  });

  it('blends angles the short way around', () => {
    near(lerpAngle(3, -3, 0.5), Math.PI, 0.3);
    assert.ok(Math.abs(lerpAngle(3, -3, 0.5)) > 3);
  });
});
