import { damagePerSecond, aggregateDamage } from './aggregate.ts';
import { buildAssignments } from './rank.ts';
import { buildWindows, toReportTime } from './windows.ts';
import type { WCLClient, RateLimitInfo } from '../wcl/client.ts';
import { DEFAULT_DAMAGE_FILTER } from '../wcl/filters.ts';
import {
  buildActorLookup,
  fetchDamageWindows,
  fetchReportMeta,
  parseReportInput,
  selectFights,
} from '../wcl/report.ts';
import type { ReportFight } from '../wcl/types.ts';

export type AnalyzeOptions = {
  /** Fight id, comma-separated ids, `last`, or `all`. Defaults to the last kill. */
  fight?: string;
  encounterID?: number;
  windowMs?: number;
  offsetMs?: number;
  slots?: number;
  /** Empty string disables server-side ability filtering. */
  filterExpression?: string;
  maxWindows?: number;
};

export type AnalyzeWindowEntry = {
  key: string;
  name: string;
  server?: string;
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
  assignments: { key: string; name: string; dps: number; priority: boolean }[];
};

export type AnalyzeResult = {
  report: { code: string; title: string; region: string; zone: string | null };
  fights: Pick<ReportFight, 'id' | 'encounterID' | 'name' | 'kill' | 'difficulty' | 'startTime' | 'endTime'>[];
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

  const windowMs = options.windowMs ?? 6000;
  const offsetMs = options.offsetMs ?? 4000;
  const slots = options.slots ?? 4;
  const filterExpression =
    options.filterExpression === undefined ? DEFAULT_DAMAGE_FILTER : options.filterExpression;

  const meta = await fetchReportMeta(client, code);
  const candidates = selectFights(meta, options.encounterID);
  if (!candidates.length) throw new Error('No analyzable encounters in this report');

  const fights = pickFights(candidates, options.fight, urlFightId);
  if (!fights.length) throw new Error('No fight matched the requested id');

  const longest = Math.max(...fights.map((fight) => fight.endTime - fight.startTime));
  const windows = buildWindows(longest, {
    sizeMs: windowMs,
    offsetMs,
    ...(options.maxWindows ? { maxWindows: options.maxWindows } : {}),
  });
  if (!windows.length) throw new Error('Fights are too short for the configured window offset');

  const lookup = buildActorLookup(meta);
  const perFight = [];

  for (const fight of fights) {
    const duration = fight.endTime - fight.startTime;
    // Skip windows past the end of shorter fights instead of paying for empty tables.
    const usable = windows.filter((window) => window.startTime < duration);
    const damage = await fetchDamageWindows(client, code, fight, toReportTime(usable, fight.startTime), {
      ...(filterExpression ? { filterExpression } : {}),
    });

    perFight.push({ windows, damage });
  }

  const aggregated = aggregateDamage(perFight, lookup);
  const assignments = buildAssignments(aggregated, { slots });
  const assignmentByIndex = new Map(assignments.map((assignment) => [assignment.window.index, assignment]));

  return {
    report: {
      code: meta.code,
      title: meta.title,
      region: meta.region.slug,
      zone: meta.zone?.name ?? null,
    },
    fights: fights.map(({ id, encounterID, name, kill, difficulty, startTime, endTime }) => ({
      id,
      encounterID,
      name,
      kill,
      difficulty,
      startTime,
      endTime,
    })),
    windows: aggregated.map((row) => ({
      index: row.window.index,
      startTime: row.window.startTime,
      endTime: row.window.endTime,
      entries: row.entries.map((entry) => ({
        key: entry.actor.key,
        name: entry.actor.name,
        ...(entry.actor.server ? { server: entry.actor.server } : {}),
        dps: Math.round(damagePerSecond(entry, row.window)),
        average: entry.average,
        samples: entry.count,
      })),
      assignments: (assignmentByIndex.get(row.window.index)?.slots ?? []).map((slot) => {
        const entry = row.entries.find((candidate) => candidate.actor.key === slot.key);
        return {
          key: slot.key,
          name: slot.name,
          dps: entry ? Math.round(damagePerSecond(entry, row.window)) : 0,
          priority: slot.priority,
        };
      }),
    })),
    rateLimit: client.lastRateLimit,
  };
}
