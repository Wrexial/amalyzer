import type { PrescienceApplication } from './prescience.ts';

/** A WCL support damage event (damage reattributed by an Aug buff). */
export type SupportDamageEvent = {
  /** Report-relative timestamp. */
  timestamp: number;
  /** Ability id of the support event (buff/fate mirror/…). */
  abilityGameID?: number;
  /** Aug Evoker actor id. */
  sourceID?: number;
  /** Actor id of the buffed player whose damage was reattributed. */
  supportID?: number;
  /** Reattributed damage; can be negative (known WCL stacked-enemy quirk). */
  amount: number;
};

/**
 * Buckets support events onto the buff application that was active for the
 * supported player. Keys are `startTime:targetID` (fight-relative), so two
 * targets cast at the same instant stay separate.
 *
 * An event only counts for the exact target + caster application, which is what
 * makes a row mean "Kyokan's Prescience damage from Amabuff".
 */
export function sumSupportByApplication(
  applications: PrescienceApplication[],
  events: SupportDamageEvent[],
  fightStartTime: number,
): Map<string, number> {
  const applicationsByTarget = new Map<number, PrescienceApplication[]>();
  for (const application of applications) {
    const list = applicationsByTarget.get(application.targetID) ?? [];
    list.push(application);
    applicationsByTarget.set(application.targetID, list);
  }

  const totals = new Map<string, number>();

  for (const event of events) {
    if (event.supportID == null || !Number.isFinite(event.amount)) continue;

    const candidates = applicationsByTarget.get(event.supportID) ?? [];
    const application = candidates.find(
      (candidate) =>
        candidate.timestamp <= event.timestamp &&
        event.timestamp < candidate.endTimestamp &&
        (event.sourceID == null || candidate.sourceID === event.sourceID),
    );
    if (!application) continue;

    const startTime = Math.round(application.timestamp) - fightStartTime;
    const key = `${startTime}:${application.targetID}`;
    totals.set(key, (totals.get(key) ?? 0) + event.amount);
  }

  return totals;
}
