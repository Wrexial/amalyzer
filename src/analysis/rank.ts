import type { AggregatedEntry, AggregatedWindow } from './aggregate.ts';
import type { TimeWindow } from '../wcl/types.ts';

export type AssignmentSlot = {
  key: string;
  name: string;
  /** Class name for colour coding, when known. */
  class?: string;
  /** Spec names from playerDetails, used for client-side filtering. */
  specs?: string[];
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
  /**
   * Per-window forced picks (the Prescience cast target of that cast). If the
   * actor is not already selected by damage, they take the last slot.
   */
  forcedByIndex?: ReadonlyMap<number, string>;
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
        ...(entry?.actor.class ? { class: entry.actor.class } : {}),
        ...(entry?.actor.specs?.length ? { specs: entry.actor.specs } : {}),
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
        ...(entry.actor.class ? { class: entry.actor.class } : {}),
        ...(entry.actor.specs?.length ? { specs: entry.actor.specs } : {}),
        average: entry.average,
        priority: false,
      });
    }

    const forcedKey = options.forcedByIndex?.get(window.window.index);
    if (
      forcedKey &&
      !excluded.has(forcedKey) &&
      !chosen.some((slot) => slot.key === forcedKey)
    ) {
      const entry = available.find((candidate) => candidate.actor.key === forcedKey);
      const forcedSlot: AssignmentSlot = {
        key: forcedKey,
        name: entry?.actor.name ?? forcedKey.split('@')[0] ?? forcedKey,
        ...(entry?.actor.class ? { class: entry.actor.class } : {}),
        ...(entry?.actor.specs?.length ? { specs: entry.actor.specs } : {}),
        average: entry?.average ?? 0,
        priority: false,
      };

      if (chosen.length < slots) {
        chosen.push(forcedSlot);
      } else {
        // Replace the last slot, preferring a non-priority pick.
        let replaceAt = chosen.length - 1;
        for (let i = chosen.length - 1; i >= 0; i -= 1) {
          if (!chosen[i]!.priority) {
            replaceAt = i;
            break;
          }
        }
        chosen[replaceAt] = forcedSlot;
      }
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
