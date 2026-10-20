import { damagePerSecond, aggregateDamage } from './aggregate.ts';
import { fightPhases, type PhaseBoundary } from './phases.ts';
import { buildAssignments } from './rank.ts';
import { buildPrescienceWindows, buildWindows, toReportTime } from './windows.ts';
import type { WCLClient, RateLimitInfo } from '../wcl/client.ts';
import { DEFAULT_DAMAGE_FILTER } from '../wcl/filters.ts';
import {
  buildActorLookup,
  fetchDamageWindows,
  fetchPrescienceBuffEvents,
  fetchPrescienceCasts,
  fetchShiftingSandsBuffEvents,
  fetchReportMeta,
  isAugmentationEvoker,
  parseReportInput,
  selectFights,
} from '../wcl/report.ts';
import { buildPrescienceApplications, matchPrescienceRecipients } from '../wcl/prescience.ts';
import { PRESCIENCE_BUFF_ID, SHIFTING_SANDS_BUFF_ID } from '../wcl/queries.ts';
import type { ReportFight, TimeWindow, WindowDamage } from '../wcl/types.ts';

/** How the analysis slices a fight into damage windows. */
export type WindowMode = 'prescience-buff' | 'shifting-sands' | 'fixed';

export type AnalyzeOptions = {
  /** Fight id, comma-separated ids, `last`, or `all`. Defaults to the last kill. */
  fight?: string;
  encounterID?: number;
  /**
   * `prescience-buff` (default): one window per cast, lasting that aura's actual
   * duration. `shifting-sands`: one window per Shifting Sands application.
   * `fixed`: the old clock-based grid.
   */
  windowMode?: WindowMode;
  /** Prescience fallback length in ms, used when the log has no removal event. */
  prescienceDurationMs?: number;
  /** Shifting Sands fallback length in ms. Default 10400 (10s + 4% mastery). */
  shiftingSandsDurationMs?: number;
  windowMs?: number;
  offsetMs?: number;
  slots?: number;
  /** Empty string disables server-side ability filtering. */
  filterExpression?: string;
  maxWindows?: number;
  /** Drop Augmentation Evokers from the rankings and assignments. */
  excludeAugmentation?: boolean;
  /** Only analyze this Augmentation Evoker's casts/applications (actor id). */
  augmenterId?: number;
  /** Name alternative to `augmenterId`. */
  augmenterName?: string;
};

export type AnalyzeWindowEntry = {
  key: string;
  name: string;
  server?: string;
  /** Class name, for colour coding and icons in the UI. */
  class?: string;
  /** Spec names from playerDetails, for client-side filters. */
  specs?: string[];
  /** Expected damage per second inside this window. */
  dps: number;
  /** Expected damage inside the window (not normalised by duration). */
  average: number;
  samples: number;
};

export type AnalyzeWindow = {
  index: number;
  startTime: number;
  endTime: number;
  entries: AnalyzeWindowEntry[];
  /** Actor this row's Prescience/Shifting Sands was applied to, when known. */
  castTarget?: { key: string; name: string };
  /** Aug Evoker that applied this window's buff. */
  aug?: { key: string; name: string };
  /** Raw cast target when WCL logged a non-player (usually an enemy boss). */
  castEnemyTarget?: { name: string };
  /** Actors with an active Prescience at this window's cast (cast target included). */
  buffed?: { key: string; name: string }[];
  /** WCL-reattributed support damage for this buff window (sum over the buffed target's damage). */
  supportDamage?: number;
  assignments: {
    key: string;
    name: string;
    class?: string;
    specs?: string[];
    dps: number;
    /** Raw expected damage in the window (pre-DPS). */
    average: number;
    priority: boolean;
  }[];
};

export type PrescienceCastInfo = {
  /** Fight-relative start of the window this cast created. */
  startTime: number;
  /** How long the aura actually lasted (fight-relative, clipped to the fight). */
  durationMs: number;
  /** Actor the Prescience buff actually landed on. */
  target?: { key: string; name: string };
  /** Raw cast target when it was an enemy/NPC instead of the buff recipient. */
  enemyTarget?: { name: string };
  /** True when this cast refreshed an existing Prescience on the same target. */
  extended?: boolean;
  /** Aug Evoker that cast/applied this window's buff. */
  source?: { key: string; name: string };
  /** Actor id of the Aug Evoker (used for the support-damage table query). */
  sourceId?: number;
};

export type AnalyzeFight = Pick<
  ReportFight,
  'id' | 'encounterID' | 'name' | 'kill' | 'difficulty' | 'startTime' | 'endTime'
> & {
  /** Fight-relative phase boundaries parsed from WCL's report-relative transitions. */
  phases: PhaseBoundary[];
  /** One entry per Prescience window (empty in fixed mode). */
  casts?: PrescienceCastInfo[];
};

export type AnalyzeResult = {
  report: { code: string; title: string; region: string; zone: string | null };
  /** `fixed` also means "requested aura windows but found no events". */
  windowMode: WindowMode;
  /** True when aura windows were requested but no events were found. */
  windowModeFallback: boolean;
  prescienceDurationMs?: number;
  shiftingSandsDurationMs?: number;
  fights: AnalyzeFight[];
  windows: AnalyzeWindow[];
  rateLimit: RateLimitInfo;
};

export function pickFights(
  candidates: ReportFight[],
  requested: string | undefined,
  fromUrl: number | 'last' | undefined,
): ReportFight[] {
  if (requested === 'all') return candidates;

  const explicit = requested ?? (fromUrl === 'last' ? 'last' : fromUrl?.toString());
  const lastKill = [...candidates].reverse().find((fight) => fight.kill);
  const fallback = [lastKill ?? candidates[candidates.length - 1]].filter(Boolean) as ReportFight[];

  if (!explicit) return fallback;

  if (explicit === 'last') {
    return [lastKill ?? candidates[candidates.length - 1]].filter(Boolean) as ReportFight[];
  }

  const ids = explicit
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id));

  return candidates.filter((fight) => ids.includes(fight.id));
}

/**
 * Full pipeline: report -> fights -> windows -> damage -> ranked assignments.
 *
 * Shared by the CLI and the local web harness so both exercise identical code.
 */
export async function analyzeReport(
  client: WCLClient,
  input: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const { code, fightId: urlFightId } = parseReportInput(input);
  if (!code) throw new Error('Could not find a report code in that input');

  const windowMode: WindowMode =
    options.windowMode === 'fixed' || options.windowMode === 'shifting-sands'
      ? options.windowMode
      : 'prescience-buff';
  const prescienceDurationMs = options.prescienceDurationMs ?? 18_000;
  const shiftingSandsDurationMs = options.shiftingSandsDurationMs ?? 10_400;
  const windowMs = options.windowMs ?? 27_000;
  const offsetMs = options.offsetMs ?? 4000;
  const slots = options.slots ?? 4;
  const filterExpression =
    options.filterExpression === undefined ? DEFAULT_DAMAGE_FILTER : options.filterExpression;

  const meta = await fetchReportMeta(client, code);
  const augmenterId =
    options.augmenterId ??
    (options.augmenterName
      ? meta.players.find(
          (player) => player.name.toLowerCase() === options.augmenterName!.trim().toLowerCase(),
        )?.id
      : undefined);
  const candidates = selectFights(meta, options.encounterID);
  if (!candidates.length) throw new Error('No analyzable encounters in this report');

  const fights = pickFights(candidates, options.fight, urlFightId);
  if (!fights.length) throw new Error('No fight matched the requested id');

  const longest = Math.max(...fights.map((fight) => fight.endTime - fight.startTime));
  const fixedWindows = buildWindows(longest, {
    sizeMs: windowMs,
    offsetMs,
    ...(options.maxWindows ? { maxWindows: options.maxWindows } : {}),
  });

  const lookup = buildActorLookup(meta);

  // Prescience casts first: one window per cast, per fight. Fights differ in
  // cast count/timing, so each gets its own list; the window index is the cast
  // ordinal, which keeps "the Nth Prescience" comparable across pulls.
  const castsByFightId = new Map<number, TimeWindow[]>();
  const castInfoByFightId = new Map<number, PrescienceCastInfo[]>();
  const buffedByFightId = new Map<number, { key: string; name: string }[][]>();
  let castsFound = 0;

  if (windowMode !== 'fixed') {
    for (const fight of fights) {
      if (windowMode === 'shifting-sands') {
        const duration = fight.endTime - fight.startTime;
        const buffEvents = await fetchShiftingSandsBuffEvents(client, code, fight);
        const applications = buildPrescienceApplications(
          buffEvents.filter(
            (event) => event.targetID != null && lookup.get(event.targetID)?.isPlayer,
          ),
          fight.endTime,
          shiftingSandsDurationMs,
        );
        const windowApplications = augmenterId
          ? applications.filter((application) => application.sourceID === augmenterId)
          : applications;
        castsFound += windowApplications.length;

        const windows = buildPrescienceWindows(
          windowApplications.map((application) => ({
            timestamp: application.timestamp,
            endTimestamp: application.endTimestamp,
          })),
          fight.startTime,
          duration,
          shiftingSandsDurationMs,
        );
        castsByFightId.set(fight.id, windows);

        const targetByStart = new Map<number, { key: string; name: string }>();
        const sourceByStart = new Map<number, { key: string; name: string }>();
        const sourceIdByStart = new Map<number, number>();
        const extendedByStart = new Set<number>();
        for (const application of windowApplications) {
          const actor = lookup.get(application.targetID);
          if (!actor) continue;

          const startTime = Math.round(application.timestamp) - fight.startTime;
          if (!targetByStart.has(startTime)) {
            targetByStart.set(startTime, { key: actor.key, name: actor.name });
          }
          const sourceActor =
            application.sourceID != null ? lookup.get(application.sourceID) : undefined;
          if (sourceActor && !sourceByStart.has(startTime)) {
            sourceByStart.set(startTime, { key: sourceActor.key, name: sourceActor.name });
          }
          if (application.sourceID != null && !sourceIdByStart.has(startTime)) {
            sourceIdByStart.set(startTime, application.sourceID);
          }
          if (application.extended) extendedByStart.add(startTime);
        }

        castInfoByFightId.set(
          fight.id,
          windows.map((window) => ({
            startTime: window.startTime,
            durationMs: window.endTime - window.startTime + 1,
            ...(targetByStart.has(window.startTime)
              ? { target: targetByStart.get(window.startTime)! }
              : {}),
            ...(extendedByStart.has(window.startTime) ? { extended: true } : {}),
            ...(sourceByStart.has(window.startTime)
              ? { source: sourceByStart.get(window.startTime)! }
              : {}),
            ...(sourceIdByStart.has(window.startTime)
              ? { sourceId: sourceIdByStart.get(window.startTime)! }
              : {}),
          })),
        );

        buffedByFightId.set(
          fight.id,
          windows.map((window) => {
            const active = new Map<string, { key: string; name: string }>();
            for (const application of applications) {
              const start = application.timestamp - fight.startTime;
              const end = application.endTimestamp - fight.startTime;
              if (start > window.startTime || window.startTime >= end) continue;

              const actor = lookup.get(application.targetID);
              if (actor) active.set(actor.key, { key: actor.key, name: actor.name });
            }

            const currentTarget = targetByStart.get(window.startTime);
            if (currentTarget) active.set(currentTarget.key, currentTarget);
            return [...active.values()];
          }),
        );

        continue;
      }

      const [rawCasts, buffEvents] = await Promise.all([
        fetchPrescienceCasts(client, code, fight),
        fetchPrescienceBuffEvents(client, code, fight),
      ]);
      const applications = buildPrescienceApplications(
        // Prescience gets copied/applied to pets in the log (Akaari's Soul,
        // ghouls, …). Those are noise: only players can receive a useful
        // Prescience, and pet buffs have short, misleading lifetimes.
        buffEvents.filter(
          (event) => event.targetID != null && lookup.get(event.targetID)?.isPlayer,
        ),
        fight.endTime,
        prescienceDurationMs,
      );
      const casts = matchPrescienceRecipients(
        augmenterId ? rawCasts.filter((cast) => cast.sourceID === augmenterId) : rawCasts,
        applications,
      );
      const duration = fight.endTime - fight.startTime;
      castsFound += casts.length;

      const windows = buildPrescienceWindows(
        casts.map((cast) => ({
          timestamp: cast.timestamp,
          ...(cast.applicationEndTimestamp != null
            ? { endTimestamp: cast.applicationEndTimestamp }
            : {}),
        })),
        fight.startTime,
        duration,
        prescienceDurationMs,
      );
      castsByFightId.set(fight.id, windows);

      const targetByStart = new Map<number, { key: string; name: string }>();
      const enemyByStart = new Map<number, { name: string }>();
      const extendedByStart = new Set<number>();
      const sourceByStart = new Map<number, { key: string; name: string }>();
      const sourceIdByStart = new Map<number, number>();

      for (const cast of casts) {
        const rawTarget = cast.targetID != null ? lookup.get(cast.targetID) : undefined;
        const buffTarget = cast.recipientID != null ? lookup.get(cast.recipientID) : undefined;
        // A cast on a player is unambiguous, so trust it. Only enemy/NPC-targeted
        // casts (WCL often records the boss the Evoker had selected) need the
        // buff event to discover who actually received the aura.
        const recipient = rawTarget?.isPlayer ? rawTarget : buffTarget;
        const startTime = Math.round(cast.timestamp) - fight.startTime;

        if (recipient && !targetByStart.has(startTime)) {
          targetByStart.set(startTime, { key: recipient.key, name: recipient.name });
        }

        if (rawTarget && !rawTarget.isPlayer && !enemyByStart.has(startTime)) {
          enemyByStart.set(startTime, { name: rawTarget.name });
        }

        if (cast.extended) extendedByStart.add(startTime);

        const sourceActor = cast.sourceID != null ? lookup.get(cast.sourceID) : undefined;
        if (sourceActor && !sourceByStart.has(startTime)) {
          sourceByStart.set(startTime, { key: sourceActor.key, name: sourceActor.name });
        }
        if (cast.sourceID != null && !sourceIdByStart.has(startTime)) {
          sourceIdByStart.set(startTime, cast.sourceID);
        }
      }

      castInfoByFightId.set(
        fight.id,
        windows.map((window) => ({
          startTime: window.startTime,
          durationMs: window.endTime - window.startTime + 1,
          ...(targetByStart.has(window.startTime)
            ? { target: targetByStart.get(window.startTime)! }
            : {}),
          ...(enemyByStart.has(window.startTime)
            ? { enemyTarget: enemyByStart.get(window.startTime)! }
            : {}),
          ...(extendedByStart.has(window.startTime) ? { extended: true } : {}),
          ...(sourceByStart.has(window.startTime)
            ? { source: sourceByStart.get(window.startTime)! }
            : {}),
          ...(sourceIdByStart.has(window.startTime)
            ? { sourceId: sourceIdByStart.get(window.startTime)! }
            : {}),
        })),
      );

      // Back-check from the aura applications themselves (apply/remove/refresh),
      // so the buffed set uses actual lifetimes instead of a fixed assumption.
      buffedByFightId.set(
        fight.id,
        windows.map((window) => {
          const active = new Map<string, { key: string; name: string }>();
          for (const application of applications) {
            const start = application.timestamp - fight.startTime;
            const end = application.endTimestamp - fight.startTime;
            if (start > window.startTime || window.startTime >= end) continue;

            const actor = lookup.get(application.targetID);
            if (actor) active.set(actor.key, { key: actor.key, name: actor.name });
          }

          const currentTarget = targetByStart.get(window.startTime);
          if (currentTarget) active.set(currentTarget.key, currentTarget);

          return [...active.values()];
        }),
      );
    }
  }

  // No casts (no Aug Evoker in the pull, or a mode change) -> fixed grid.
  const effectiveMode: WindowMode = windowMode !== 'fixed' && castsFound > 0 ? windowMode : 'fixed';

  const perFight: { windows: TimeWindow[]; damage: WindowDamage[] }[] = [];
  const supportTotals = new Map<number, { sum: number; count: number }>();

  for (const fight of fights) {
    const duration = fight.endTime - fight.startTime;
    const windows =
      effectiveMode === 'fixed'
        ? fixedWindows.filter((window) => window.startTime < duration)
        : castsByFightId.get(fight.id) ?? [];

    if (!windows.length) continue;

    const castInfos = castInfoByFightId.get(fight.id) ?? [];
    const reportWindows = toReportTime(windows, fight.startTime).map((window) => {
      const sourceId = castInfos[window.index]?.sourceId;
      return {
        ...window,
        ...(sourceId != null
          ? {
              support: {
                abilityId:
                  windowMode === 'shifting-sands' ? SHIFTING_SANDS_BUFF_ID : PRESCIENCE_BUFF_ID,
                sourceId,
              },
            }
          : {}),
      };
    });

    const damage = await fetchDamageWindows(client, code, fight, reportWindows, {
      ...(filterExpression ? { filterExpression } : {}),
    });

    for (const row of damage) {
      if (row.supportDamage == null) continue;
      const total = supportTotals.get(row.windowIndex) ?? { sum: 0, count: 0 };
      total.sum += row.supportDamage;
      total.count += 1;
      supportTotals.set(row.windowIndex, total);
    }

    perFight.push({ windows, damage });
  }

  if (!perFight.length) {
    throw new Error(
      effectiveMode === 'fixed'
        ? 'Fights are too short for the configured window offset'
        : windowMode === 'shifting-sands'
          ? 'No Shifting Sands applications found in the selected fights'
          : 'No Prescience casts found in the selected fights',
    );
  }

  const aggregated = aggregateDamage(perFight, lookup);
  const excludedActors = options.excludeAugmentation
    ? new Set(
        [...lookup.values()].filter((actor) => isAugmentationEvoker(actor)).map((actor) => actor.key),
      )
    : new Set<string>();

  // Pets/summons show up as their own damage-table actors. Like the original
  // tool, keep only real players in the candidate list.
  const visible = aggregated.map((row) => ({
    ...row,
    entries: row.entries.filter(
      (entry) => entry.actor.isPlayer && !excludedActors.has(entry.actor.key),
    ),
  }));

  // The aggregated window N can come from different pulls; use the longest
  // fight's cast target/buff state for each ordinal (falling back to shorter
  // fights).
  const castTargetByIndex = new Map<number, { key: string; name: string }>();
  const augByIndex = new Map<number, { key: string; name: string }>();
  const enemyTargetByIndex = new Map<number, { name: string }>();
  const buffedByIndex = new Map<number, { key: string; name: string }[]>();
  const fightsLongestFirst = [...fights].sort(
    (a, b) => b.endTime - b.startTime - (a.endTime - a.startTime),
  );
  for (const fight of fightsLongestFirst) {
    (castInfoByFightId.get(fight.id) ?? []).forEach((cast, index) => {
      if (cast.target && !castTargetByIndex.has(index)) castTargetByIndex.set(index, cast.target);
      if (cast.source && !augByIndex.has(index)) augByIndex.set(index, cast.source);
      if (cast.enemyTarget && !enemyTargetByIndex.has(index)) {
        enemyTargetByIndex.set(index, cast.enemyTarget);
      }
    });
    (buffedByFightId.get(fight.id) ?? []).forEach((buffed, index) => {
      if (!buffedByIndex.has(index)) buffedByIndex.set(index, buffed);
    });
  }

  const assignments = buildAssignments(visible, {
    slots,
    excluded: excludedActors,
  });
  const assignmentByIndex = new Map(assignments.map((assignment) => [assignment.window.index, assignment]));

  return {
    report: {
      code: meta.code,
      title: meta.title,
      region: meta.region.slug,
      zone: meta.zone?.name ?? null,
    },
    windowMode: effectiveMode,
    windowModeFallback: windowMode !== 'fixed' && effectiveMode === 'fixed',
    ...(effectiveMode === 'prescience-buff' ? { prescienceDurationMs } : {}),
    ...(effectiveMode === 'shifting-sands' ? { shiftingSandsDurationMs } : {}),
    fights: fights.map((fight) => ({
      id: fight.id,
      encounterID: fight.encounterID,
      name: fight.name,
      kill: fight.kill,
      difficulty: fight.difficulty,
      startTime: fight.startTime,
      endTime: fight.endTime,
      phases: fightPhases(fight),
      ...(effectiveMode !== 'fixed'
        ? { casts: castInfoByFightId.get(fight.id) ?? [] }
        : {}),
    })),
    windows: visible.map((row) => ({
      index: row.window.index,
      startTime: row.window.startTime,
      endTime: row.window.endTime,
      ...(castTargetByIndex.has(row.window.index)
        ? { castTarget: castTargetByIndex.get(row.window.index)! }
        : {}),
      ...(augByIndex.has(row.window.index) ? { aug: augByIndex.get(row.window.index)! } : {}),
      ...(supportTotals.has(row.window.index)
        ? {
            supportDamage: Math.round(
              supportTotals.get(row.window.index)!.sum /
                supportTotals.get(row.window.index)!.count,
            ),
          }
        : {}),
      ...(enemyTargetByIndex.has(row.window.index)
        ? { castEnemyTarget: enemyTargetByIndex.get(row.window.index)! }
        : {}),
      ...(buffedByIndex.has(row.window.index)
        ? { buffed: buffedByIndex.get(row.window.index)! }
        : {}),
      entries: row.entries.map((entry) => ({
        key: entry.actor.key,
        name: entry.actor.name,
        ...(entry.actor.server ? { server: entry.actor.server } : {}),
        ...(entry.actor.class ? { class: entry.actor.class } : {}),
        ...(entry.actor.specs?.length ? { specs: entry.actor.specs } : {}),
        dps: Math.round(damagePerSecond(entry, row.window)),
        average: entry.average,
        samples: entry.count,
      })),
      assignments: (assignmentByIndex.get(row.window.index)?.slots ?? []).map((slot) => {
        const entry = row.entries.find((candidate) => candidate.actor.key === slot.key);
        const className = entry?.actor.class ?? slot.class;
        const specs = entry?.actor.specs ?? slot.specs;
        return {
          key: slot.key,
          name: slot.name,
          ...(className ? { class: className } : {}),
          ...(specs?.length ? { specs } : {}),
          dps: entry ? Math.round(damagePerSecond(entry, row.window)) : 0,
          average: slot.average,
          priority: slot.priority,
        };
      }),
    })),
    rateLimit: client.lastRateLimit,
  };
}
