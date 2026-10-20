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
  /** True when this application refreshed a Prescience that was already active. */
  extended?: boolean;
};

export type MatchedPrescienceCast = PrescienceCast & {
  /** Actual buff recipient, from the matched application. */
  recipientID?: number;
  /** Exclusive report-relative end of the aura this cast applied. */
  applicationEndTimestamp?: number;
  /** True when the cast refreshed an existing Prescience on that target. */
  extended?: boolean;
};

/**
 * Turns raw aura events into application intervals.
 *
 * - `applybuff` starts a window. `refreshbuff` (or an apply while the aura is
 *   already active) **extends** it: the previous window ends at the refresh and
 *   the new one runs from there, so `#1 -> #5` and `#5 -> removal` are separate
 *   durations instead of one merged buff.
 * - `removebuff` closes the active window (death, dispel, or normal expiry).
 * - A window still open when the fight ends is capped at the fallback duration,
 *   because the removal is missing from the log.
 */
export function buildPrescienceApplications(
  events: PrescienceBuffEvent[],
  fightEndTimestamp: number,
  fallbackDurationMs: number,
): PrescienceApplication[] {
  const applications: PrescienceApplication[] = [];
  const active = new Map<number, Omit<PrescienceApplication, 'endTimestamp'>>();

  const close = (targetID: number, endTimestamp: number) => {
    const current = active.get(targetID);
    if (!current) return;

    applications.push({
      ...current,
      endTimestamp: Math.max(current.timestamp, endTimestamp),
    });
    active.delete(targetID);
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

    const wasActive = active.has(event.targetID);
    close(event.targetID, event.timestamp);
    active.set(event.targetID, {
      timestamp: event.timestamp,
      ...(event.sourceID ? { sourceID: event.sourceID } : {}),
      targetID: event.targetID,
      ...(wasActive || event.type === 'refreshbuff' ? { extended: true } : {}),
    });
  }

  for (const current of active.values()) {
    applications.push({
      ...current,
      endTimestamp: Math.min(
        Math.max(current.timestamp, fightEndTimestamp),
        current.timestamp + fallbackDurationMs,
      ),
    });
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

        // Prefer the application on the cast's own target; this keeps an
        // unrelated buff event on another player from winning on timestamp.
        const sameTarget = cast.targetID != null && application.targetID === cast.targetID;
        const distance = Math.abs(delta) + (sameTarget ? 0 : 1000);
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
        ...(application.extended ? { extended: true } : {}),
      };
    });
}
