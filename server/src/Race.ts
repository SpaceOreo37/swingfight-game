import { RACE, passesThrough, type RaceCourse, type RacePhase, type ServerMessage, type Vec3 } from '@game/shared';
import type { Actor } from './Actor';

interface Run {
  /** Part of the room's group race (vs. a solo time trial). */
  group: boolean;
  /** Server time the run's clock started. */
  start: number;
  /** Index of the next checkpoint to pass. */
  next: number;
  done: boolean;
  time?: number;
}

export interface RaceHost {
  players(): Iterable<Actor>;
  broadcast(msg: ServerMessage): void;
}

/**
 * Race mode for one room. The server watches every player's movement and
 * decides when they pass each checkpoint, so times can't be faked.
 *
 * - Fly through the start ring any time: a solo time trial starts.
 * - Anyone can start a group race: a countdown, everyone lines up, GO.
 */
export class Race {
  phase: RacePhase = 'idle';
  private startAt = 0;
  private endsAt = 0;
  private racers: string[] = [];
  private readonly runs = new Map<string, Run>();
  private readonly best = new Map<string, number>();
  private last: [string, number][] = [];

  constructor(
    private readonly host: RaceHost,
    readonly course: RaceCourse,
  ) {}

  private get total(): number {
    return this.course.checkpoints.length;
  }

  /** Start a group race (if one isn't already on). */
  requestStart(now: number): void {
    if (this.phase !== 'idle') return;
    const players = [...this.host.players()].filter((p) => !p.isBot);
    if (!players.length) return;
    this.phase = 'countdown';
    this.startAt = now + RACE.countdownMs;
    this.endsAt = this.startAt + RACE.maxRaceMs;
    this.racers = players.map((p) => p.id);
    // Everyone's clock starts at GO; the first ring to pass is the start ring.
    for (const id of this.racers) this.runs.set(id, { group: true, start: this.startAt, next: 0, done: false });
    this.broadcastPhase();
  }

  /** Called with each new position a player reports. */
  onMove(a: Actor, from: Vec3 | null, to: Vec3, now: number): void {
    if (!from) return;
    const jump = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    let run = this.runs.get(a.id);

    if (jump > RACE.teleportDistance) {
      // Respawned / teleported: that doesn't count as flying through rings. Solo runs reset.
      if (run && !run.group) this.runs.delete(a.id);
      return;
    }

    if (!run) {
      // Not in a run: flying through the start ring starts a solo time trial.
      if (passesThrough(from, to, this.course.checkpoints[0], this.course.radius)) {
        run = { group: false, start: now, next: 1, done: false };
        this.runs.set(a.id, run);
        this.host.broadcast({ t: 'raceCp', id: a.id, cp: 0, total: this.total, time: 0, group: false });
      }
      return;
    }
    if (run.done) return;
    if (run.group && this.phase !== 'running') return; // lined up, waiting for GO

    const cp = this.course.checkpoints[run.next];
    if (!passesThrough(from, to, cp, this.course.radius)) return;
    const time = Math.max(0, now - run.start);
    this.host.broadcast({ t: 'raceCp', id: a.id, cp: run.next, total: this.total, time, group: run.group });
    run.next++;
    if (run.next < this.total) return;

    // Finished.
    run.done = true;
    run.time = time;
    const prev = this.best.get(a.id);
    if (prev === undefined || time < prev) this.best.set(a.id, time);
    if (!run.group) this.runs.delete(a.id); // ready for another solo run
    this.broadcastBoard();
    if (run.group && this.racers.every((id) => this.runs.get(id)?.done || !this.runs.has(id))) this.finishGroup();
  }

  tick(now: number): void {
    if (this.phase === 'countdown' && now >= this.startAt) {
      this.phase = 'running';
      this.broadcastPhase();
    } else if (this.phase === 'running' && now >= this.endsAt) {
      this.finishGroup();
    }
  }

  removeActor(id: string): void {
    this.runs.delete(id);
    this.racers = this.racers.filter((r) => r !== id);
    if (this.phase !== 'idle' && this.racers.length === 0) {
      this.phase = 'idle';
      this.broadcastPhase();
    }
  }

  /** What a newcomer needs to know. */
  snapshot(): ServerMessage[] {
    return [this.phaseMessage(), this.boardMessage()];
  }

  private finishGroup(): void {
    this.last = this.racers
      .map((id) => [id, this.runs.get(id)?.time] as [string, number | undefined])
      .filter((e): e is [string, number] => e[1] !== undefined)
      .sort((a, b) => a[1] - b[1]);
    for (const id of this.racers) {
      const r = this.runs.get(id);
      if (r?.group) this.runs.delete(id);
    }
    this.racers = [];
    this.phase = 'idle';
    this.broadcastBoard();
    this.broadcastPhase();
  }

  private phaseMessage(): ServerMessage {
    return { t: 'race', phase: this.phase, startAt: this.startAt, endsAt: this.endsAt, racers: this.racers };
  }

  private boardMessage(): ServerMessage {
    const best = [...this.best].sort((a, b) => a[1] - b[1]).slice(0, 10);
    return { t: 'raceBoard', best, last: this.last };
  }

  private broadcastPhase(): void {
    this.host.broadcast(this.phaseMessage());
  }

  private broadcastBoard(): void {
    this.host.broadcast(this.boardMessage());
  }
}
