import type { AggregatedEntry, AggregatedWindow } from './aggregate.ts';
import type { TimeWindow } from '../wcl/types.ts';

export type AssignmentSlot = {
  key: string;
  name: string;
  average: number;
  priority: boolean;
};

export type Assignment = {
  window: TimeWindow;
  slots: AssignmentSlot[];
};

export type AssignmentOptions = {
  /** How many targets per window. Default 4 (Prescience). */
  slots?: number;
  /** Actor keys that must never be picked. */
  excluded?: Iterable<string>;
  /**
   * Actors that are force-slotted, in order, regardless of damage. Useful for
   * "always buff the raid lead / the guy with the parse".
   */
  priority?: (string | null)[];
};

/**
 * Turns ranked windows into a concrete assignment.
 *
 * Ordering rule (same idea as Augmentator): forced picks first in their given
 * order, then everything else by damage. Forced picks that have no data are
 * still emitted with `average: 0` so the plan stays stable pull-to-pull.
 */
export function buildAssignments(
  windows: AggregatedWindow[],
  options: AssignmentOptions = {},
): Assignment[] {
  const slots = options.slots ?? 4;
  const excluded = new Set(options.excluded ?? []);
  const priority = (options.priority ?? []).filter((key): key is string => Boolean(key));

  return windows.map((window) => {
    const available = window.entries.filter((entry) => !excluded.has(entry.actor.key));
    const byKey = new Map(available.map((entry) => [entry.actor.key, entry]));

    const chosen: AssignmentSlot[] = [];

    for (const key of priority) {
      if (chosen.length >= slots) break;
      if (excluded.has(key)) continue;

      const entry = byKey.get(key);
      chosen.push({
        key,
        name: entry?.actor.name ?? key.split('@')[0] ?? key,
        average: entry?.average ?? 0,
        priority: true,
      });
      byKey.delete(key);
    }

    for (const entry of byKey.values()) {
      if (chosen.length >= slots) break;
      if (entry.average <= 0) continue;

      chosen.push({
        key: entry.actor.key,
        name: entry.actor.name,
        average: entry.average,
        priority: false,
      });
    }

    return { window: window.window, slots: chosen };
  });
}

/** Convenience: top N entries of a window, excluding keys. */
export function topEntries(
  window: AggregatedWindow,
  count = 4,
  excluded: Iterable<string> = [],
): AggregatedEntry[] {
  const excludedSet = new Set(excluded);
  return window.entries
    .filter((entry) => !excludedSet.has(entry.actor.key) && entry.average > 0)
    .slice(0, count);
}
