/**
 * Prescience cast/buff reconciliation.
 *
 * WCL's `Casts` event for Prescience often records the caster's *current target*
 * (frequently an enemy boss) rather than the ally the game auto-selected for the
 * buff. The `Buffs` event for aura 410089 is the authoritative "who actually got
 * it" source, so we pair each cast with the nearest buff application.
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
  /** Caster actor id (the Aug Evoker). */
  sourceID?: number;
  /** Actor the aura was applied/refreshed on. */
  targetID?: number;
};

export type MatchedPrescienceCast = PrescienceCast & {
  /** Actual buff recipient, from the buff event when one was matched. */
  recipientID?: number;
};

/**
 * Pairs casts with buff events by timestamp.
 *
 * Buff events are matched per caster (sourceID) and consumed once, so two Aug
 * Evokers casting at the same time still map to two distinct recipients. A cast
 * without a nearby buff event keeps `recipientID` unset; the caller can fall
 * back to the raw `targetID` when it is a player.
 */
export function matchPrescienceRecipients(
  casts: PrescienceCast[],
  buffs: PrescienceBuffEvent[],
  toleranceMs = 250,
): MatchedPrescienceCast[] {
  const sortedBuffs = buffs
    .filter((buff) => buff.targetID != null)
    .sort((a, b) => a.timestamp - b.timestamp);
  const used = new Set<number>();

  return [...casts]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((cast) => {
      let bestIndex = -1;
      let bestDistance = Infinity;

      sortedBuffs.forEach((buff, index) => {
        if (used.has(index)) return;
        // Only pair a cast with its own caster's buff event; with two Aug
        // Evokers in the raid, timestamp alone is not enough.
        if (cast.sourceID != null && buff.sourceID != null && cast.sourceID !== buff.sourceID) {
          return;
        }

        const delta = buff.timestamp - cast.timestamp;
        if (delta < -toleranceMs || delta > toleranceMs) return;

        const distance = Math.abs(delta);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });

      if (bestIndex < 0) return { ...cast };

      used.add(bestIndex);
      return { ...cast, recipientID: sortedBuffs[bestIndex]!.targetID! };
    });
}
