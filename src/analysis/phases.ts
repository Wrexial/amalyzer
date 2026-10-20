import type { ReportFight } from '../wcl/types.ts';

/** A phase boundary in fight-relative milliseconds. */
export type PhaseBoundary = {
  /** WCL's semantic phase id (1-indexed, stable across pulls). */
  id: number;
  startTime: number;
};

/**
 * Normalises `fight.phaseTransitions` into fight-relative boundaries.
 *
 * WCL documents `phaseTransitions[].startTime` as report-relative, while the
 * window grid is fight-relative, so subtract the fight start. When WCL omits the
 * transition into phase 1 we synthesise it at time 0 so early windows still get
 * a label.
 */
export function fightPhases(
  fight: Pick<ReportFight, 'startTime' | 'phaseTransitions'>,
): PhaseBoundary[] {
  const phases = (fight.phaseTransitions ?? [])
    .map((transition) => ({
      id: transition.id,
      startTime: Math.max(0, transition.startTime - fight.startTime),
    }))
    .sort((a, b) => a.startTime - b.startTime);

  if (phases.length && phases[0]!.startTime > 0) phases.unshift({ id: 1, startTime: 0 });
  return phases;
}

/** Phase active at fight-relative `timeMs`, or undefined when the fight has none. */
export function phaseAt(phases: PhaseBoundary[], timeMs: number): PhaseBoundary | undefined {
  let current: PhaseBoundary | undefined;
  for (const phase of phases) {
    if (phase.startTime > timeMs) break;
    current = phase;
  }
  return current;
}

/**
 * The fight used as the phase reference for the whole grid: the longest one,
 * because the window grid is cut from the longest selected fight.
 */
export function referenceFight<T extends Pick<ReportFight, 'startTime' | 'endTime'>>(
  fights: T[],
): T | undefined {
  return fights.reduce<T | undefined>(
    (best, fight) =>
      !best || fight.endTime - fight.startTime > best.endTime - best.startTime ? fight : best,
    undefined,
  );
}
