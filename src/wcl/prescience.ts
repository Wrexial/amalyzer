/**
 * Prescience cast/buff reconciliation.
 *
 * WCL's `Casts` event for Prescience often records the caster's *current target*
 * (frequently an enemy boss) rather than the ally the game auto-selected for the
 * buff. The aura's `applybuff` / `refreshbuff` / `removebuff` events tell us who
 * actually got the buff and for how long, so we pair each cast with the nearest
 * application from the same caster.
 */

export type PrescienceCast = {
  /** Report-relative timestamp. */
  timestamp: number;
  /** Caster actor id (the Aug Evoker). */
  sourceID?: number;
  /** Raw cast target from the event — may be an enemy or 0. */
  targetID?: number;
};

export type PrescienceBuffEvent = {
  /** Report-relative timestamp. */
  timestamp: number;
  /** `applybuff`, `refreshbuff`, `removebuff`, … */
  type?: string;
  /** Caster actor id (the Aug Evoker). */
  sourceID?: number;
  /** Actor the aura was applied/refreshed/removed on. */
  targetID?: number;
};

/** One application of the aura: `[timestamp, endTimestamp)` in report time. */
export type PrescienceApplication = {
  timestamp: number;
  /** Exclusive end: the next application on that target, the removal, or the fallback. */
  endTimestamp: number;
  sourceID?: number;
  targetID: number;
};

export type MatchedPrescienceCast = PrescienceCast & {
  /** Actual buff recipient, from the matched application. */
  recipientID?: number;
  /** Exclusive report-relative end of the aura this cast applied. */
  applicationEndTimestamp?: number;
};

/**
 * Turns raw aura events into application intervals.
 *
 * - `applybuff` / `refreshbuff` starts a window for that cast. A refresh does
 *   not end the target's aura, so every application since the last removal
 *   shares the aura's end timestamp: the target stayed buffed across the refresh.
 * - `removebuff` closes every open application on that target (death, dispel,
 *   or normal expiry).
 * - Applications still open when the fight ends are capped at the fallback
 *   duration from their last start, because the removal is missing from the log.
 */
export function buildPrescienceApplications(
  events: PrescienceBuffEvent[],
  fightEndTimestamp: number,
  fallbackDurationMs: number,
): PrescienceApplication[] {
  const applications: PrescienceApplication[] = [];
  const openByTarget = new Map<number, Omit<PrescienceApplication, 'endTimestamp'>[]>();

  const close = (targetID: number, endTimestamp: number) => {
    const open = openByTarget.get(targetID);
    if (!open) return;

    for (const application of open) {
      applications.push({
        ...application,
        endTimestamp: Math.max(application.timestamp, endTimestamp),
      });
    }
    openByTarget.delete(targetID);
  };

  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (event.targetID == null) continue;

    if (event.type === 'removebuff' || event.type === 'removedebuff') {
      close(event.targetID, event.timestamp);
      continue;
    }

    if (
      event.type !== 'applybuff' &&
      event.type !== 'refreshbuff' &&
      event.type !== 'applybuffstack'
    ) {
      continue;
    }

    const open = openByTarget.get(event.targetID) ?? [];
    open.push({
      timestamp: event.timestamp,
      ...(event.sourceID ? { sourceID: event.sourceID } : {}),
      targetID: event.targetID,
    });
    openByTarget.set(event.targetID, open);
  }

  for (const open of openByTarget.values()) {
    const lastStart = open[open.length - 1]!.timestamp;
    const end = Math.min(Math.max(lastStart, fightEndTimestamp), lastStart + fallbackDurationMs);

    for (const application of open) {
      applications.push({
        ...application,
        endTimestamp: Math.max(application.timestamp, end),
      });
    }
  }

  return applications.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Pairs casts with aura applications by timestamp and caster.
 *
 * Applications are consumed once, so two Aug Evokers casting at the same time
 * still map to two distinct recipients. A cast without a nearby application
 * keeps `recipientID` unset; the caller can fall back to the raw `targetID` when
 * it is a player and to the configured duration for the window length.
 */
export function matchPrescienceRecipients(
  casts: PrescienceCast[],
  applications: PrescienceApplication[],
  toleranceMs = 250,
): MatchedPrescienceCast[] {
  const sorted = [...applications].sort((a, b) => a.timestamp - b.timestamp);
  const used = new Set<number>();

  return [...casts]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((cast) => {
      let bestIndex = -1;
      let bestDistance = Infinity;

      sorted.forEach((application, index) => {
        if (used.has(index)) return;
        // Only pair a cast with its own caster's application; with two Aug
        // Evokers in the raid, timestamp alone is not enough.
        if (
          cast.sourceID != null &&
          application.sourceID != null &&
          cast.sourceID !== application.sourceID
        ) {
          return;
        }

        const delta = application.timestamp - cast.timestamp;
        if (delta < -toleranceMs || delta > toleranceMs) return;

        const distance = Math.abs(delta);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });

      if (bestIndex < 0) return { ...cast };

      used.add(bestIndex);
      const application = sorted[bestIndex]!;
      return {
        ...cast,
        recipientID: application.targetID,
        applicationEndTimestamp: application.endTimestamp,
      };
    });
}
