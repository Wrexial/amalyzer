import type { WCLClient } from './client.ts';
import {
  buildDamageWindowsQuery,
  flattenPlayerDetails,
  isAnalyzableFight,
  REPORT_META_QUERY,
  type DamageWindowsResponse,
  type ReportMetaResponse,
} from './queries.ts';
import type {
  DamageTableEntry,
  ReportFight,
  ReportMeta,
  TimeWindow,
  WindowDamage,
} from './types.ts';

/**
 * Accepts a full WCL URL, a URL with `?fight=3`, or a bare report code.
 * WCL URLs look like:
 *   https://www.warcraftlogs.com/reports/AbCdEfGhIjKlMnOp?fight=5&type=damage-done
 *   https://classic.warcraftlogs.com/reports/AbCdEfGhIjKlMnOp#fight=last&type=summary
 */
export function parseReportInput(input: string): {
  code: string;
  fightId: number | 'last' | undefined;
} {
  const trimmed = input.trim();
  const [path, fragment = ''] = trimmed.split('#');
  const [pathname, query = ''] = (path ?? '').split('?');

  const fromPath = pathname?.match(/reports\/([A-Za-z0-9]+)/)?.[1];
  const code = fromPath ?? (pathname ?? '').replace(/\/+$/, '').split('/').pop() ?? '';
  const params = new URLSearchParams(query);
  const fragmentParams = new URLSearchParams(fragment);

  const rawFight = params.get('fight') ?? fragmentParams.get('fight');

  return {
    code,
    fightId:
      rawFight === null || rawFight === ''
        ? undefined
        : rawFight === 'last'
          ? 'last'
          : Number(rawFight),
  };
}

export async function fetchReportMeta(
  client: WCLClient,
  code: string,
): Promise<ReportMeta> {
  const data = await client.request<ReportMetaResponse>(REPORT_META_QUERY, { code });
  const report = data.reportData.report;

  if (!report) throw new Error(`Report "${code}" not found (or not public)`);

  return {
    code: report.code,
    title: report.title,
    startTime: report.startTime,
    endTime: report.endTime,
    region: report.region,
    zone: report.zone,
    fights: report.fights,
    actors: report.masterData.actors,
    players: flattenPlayerDetails(report.playerDetails.data),
  };
}

/** Boss pulls only, newest first (WCL already returns them in order). */
export function selectFights(meta: ReportMeta, encounterID?: number): ReportFight[] {
  return meta.fights.filter(
    (fight) => isAnalyzableFight(fight) && (encounterID == null || fight.encounterID === encounterID),
  );
}

/**
 * Fetches damage tables for a set of windows of one fight.
 *
 * Windows are absolute report times. Batches are fetched sequentially so we
 * never fire more than a handful of heavy queries at once.
 */
export async function fetchDamageWindows(
  client: WCLClient,
  code: string,
  fight: ReportFight,
  windows: TimeWindow[],
  options: { filterExpression?: string; batchSize?: number } = {},
): Promise<WindowDamage[]> {
  const batchSize = options.batchSize ?? 20;
  const hasFilter = Boolean(options.filterExpression);
  const results: WindowDamage[] = [];

  for (let i = 0; i < windows.length; i += batchSize) {
    const batch = windows.slice(i, i + batchSize);
    const query = buildDamageWindowsQuery(batch, hasFilter);
    const data = await client.request<DamageWindowsResponse>(query, {
      code,
      fightId: fight.id,
      ...(hasFilter ? { filter: options.filterExpression } : {}),
    });

    const report = data.reportData.report;
    if (!report) throw new Error(`Report "${code}" disappeared mid-query`);

    batch.forEach((window, index) => {
      const table = report[`w${index}`];
      results.push({
        windowIndex: window.index,
        entries: table?.entries ?? [],
      });
    });
  }

  return results;
}

export type ActorLookup = {
  id: number;
  name: string;
  server?: string;
  /** Stable-ish key for grouping across fights: `name@server`. */
  key: string;
};

/**
 * Builds the actor id -> name map.
 *
 * `masterData.actors` is the reliable source (includes pets and NPCs);
 * `playerDetails` is the reliable source for "is this a player, and what realm".
 */
export function buildActorLookup(meta: ReportMeta): Map<number, ActorLookup> {
  const lookup = new Map<number, ActorLookup>();
  const playerServers = new Map(meta.players.map((player) => [player.id, player.server]));

  const add = (id: number, name: string, server?: string) => {
    const existing = lookup.get(id);
    const resolvedServer = server ?? existing?.server ?? playerServers.get(id);

    lookup.set(id, {
      id,
      name,
      ...(resolvedServer ? { server: resolvedServer } : {}),
      key: `${name.toLowerCase()}@${(resolvedServer ?? '').toLowerCase()}`,
    });
  };

  meta.actors.forEach((actor) => add(actor.id, actor.name, actor.server));
  meta.players.forEach((player) => add(player.id, player.name, player.server));

  return lookup;
}

/** Damage entries joined with actor names; unnamed actors are dropped. */
export function resolveEntries(entries: DamageTableEntry[], lookup: Map<number, ActorLookup>) {
  return entries
    .map((entry) => {
      const actor = lookup.get(Number(entry.id));
      if (!actor) return null;
      return { actor, total: entry.total };
    })
    .filter((entry): entry is { actor: ActorLookup; total: number } => entry !== null);
}
