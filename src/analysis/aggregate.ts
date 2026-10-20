import type { ActorLookup } from '../wcl/report.ts';
import type { TimeWindow, WindowDamage } from '../wcl/types.ts';
import { windowDurationMs } from './windows.ts';

export type FightDamageInput = {
  /** Fight-relative window grid; `index` ties rows together across fights. */
  windows: TimeWindow[];
  damage: WindowDamage[];
};

export type AggregatedEntry = {
  actor: ActorLookup;
  /** Sum of damage across all windows/fights that contributed. */
  total: number;
  /** How many windows/fights contributed non-zero damage. */
  count: number;
  /** `total / count` — expected damage in one window. */
  average: number;
};

export type AggregatedWindow = {
  window: TimeWindow;
  entries: AggregatedEntry[];
};

type Bucket = { actor: ActorLookup; total: number; count: number };

/**
 * Folds per-fight window damage into one row per window index.
 *
 * Mirrors Augmentator3000's aggregation, including the two details that make the
 * numbers comparable:
 * - zero-damage windows are dropped (death, intermission, out of range) instead
 *   of dragging the average down;
 * - the divisor is the number of *contributing* samples, not the fight count.
 */
export function aggregateDamage(
  fights: FightDamageInput[],
  lookup: Map<number, ActorLookup>,
): AggregatedWindow[] {
  const windowsByIndex = new Map<number, TimeWindow>();
  const buckets = new Map<number, Map<string, Bucket>>();

  for (const fight of fights) {
    for (const window of fight.windows) windowsByIndex.set(window.index, window);

    for (const damage of fight.damage) {
      const touched = new Set<string>();

      for (const entry of damage.entries) {
        if (entry.total <= 0) continue;

        const actor = lookup.get(Number(entry.id));
        if (!actor) continue;

        // Pets/summons are separate actors in WCL's table; credit their damage
        // to the owning player so pet classes aren't under-counted.
        const resolvedActor =
          actor.isPlayer === false && actor.ownerId != null
            ? lookup.get(actor.ownerId) ?? actor
            : actor;

        let byActor = buckets.get(damage.windowIndex);
        if (!byActor) {
          byActor = new Map();
          buckets.set(damage.windowIndex, byActor);
        }

        const bucket = byActor.get(resolvedActor.key) ?? {
          actor: resolvedActor,
          total: 0,
          count: 0,
        };
        bucket.total += entry.total;
        byActor.set(resolvedActor.key, bucket);
        touched.add(resolvedActor.key);
      }

      // One sample per window, even when a player and their pets both appear.
      const byActor = buckets.get(damage.windowIndex);
      if (byActor) {
        for (const key of touched) byActor.get(key)!.count += 1;
      }
    }
  }

  const indexes = [...buckets.keys()].sort((a, b) => a - b);

  return indexes.map((index) => {
    const window = windowsByIndex.get(index);
    if (!window) throw new Error(`Missing window metadata for index ${index}`);

    const entries = [...buckets.get(index)!.values()]
      .map<AggregatedEntry>((bucket) => ({
        actor: bucket.actor,
        total: bucket.total,
        count: bucket.count,
        average: Math.round(bucket.total / bucket.count),
      }))
      .sort((a, b) => b.average - a.average);

    return { window, entries };
  });
}

/** Damage per second for a window; handles the clipped first window correctly. */
export function damagePerSecond(entry: AggregatedEntry, window: TimeWindow): number {
  const seconds = windowDurationMs(window) / 1000;
  return seconds > 0 ? entry.average / seconds : 0;
}
