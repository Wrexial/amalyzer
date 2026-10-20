import type { WCLClient } from './client.ts';
import {
  buildDamageWindowsQuery,
  flattenPlayerDetails,
  isAnalyzableFight,
  PRESCIENCE_BUFF_ID,
  PRESCIENCE_BUFFS_QUERY,
  PRESCIENCE_CAST_ID,
  PRESCIENCE_CASTS_QUERY,
  REPORT_META_QUERY,
  type DamageWindowsResponse,
  type PrescienceBuffsResponse,
  type PrescienceCastsResponse,
  type ReportMetaResponse,
} from './queries.ts';
import type { PrescienceBuffEvent, PrescienceCast } from './prescience.ts';
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
    players: flattenPlayerDetails(report.playerDetails),
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
      const parsed = table?.data ?? table;
      results.push({
        windowIndex: window.index,
        entries: parsed?.entries ?? [],
      });
    });
  }

  return results;
}

/**
 * Report-relative timestamps (and raw targets) of every Prescience cast in one fight.
 *
 * `abilityID` filters server-side, so this is one small page; the loop is only
 * there for reports with an absurd number of casts.
 */
export async function fetchPrescienceCasts(
  client: WCLClient,
  code: string,
  fight: ReportFight,
): Promise<PrescienceCast[]> {
  const casts: PrescienceCast[] = [];
  let startTime = fight.startTime;

  for (let page = 0; page < 10; page += 1) {
    const data = await client.request<PrescienceCastsResponse>(PRESCIENCE_CASTS_QUERY, {
      code,
      fightId: fight.id,
      startTime,
      endTime: fight.endTime,
    });

    const events = data.reportData.report?.events;
    if (!events?.data) break;

    events.data.forEach((event) => {
      if (event.abilityGameID != null && event.abilityGameID !== PRESCIENCE_CAST_ID) return;
      if (event.type && event.type !== 'cast') return;
      if (typeof event.timestamp !== 'number') return;
      casts.push({
        timestamp: event.timestamp,
        ...(event.sourceID ? { sourceID: event.sourceID } : {}),
        ...(event.targetID ? { targetID: event.targetID } : {}),
      });
    });

    if (events.nextPageTimestamp == null || events.nextPageTimestamp <= startTime) break;
    startTime = events.nextPageTimestamp;
  }

  return casts;
}

/**
 * Report-relative timestamps and targets of every Prescience `applybuff` /
 * `refreshbuff` in one fight. Used to resolve who actually received the buff
 * when the cast was made with an enemy target.
 */
export async function fetchPrescienceBuffEvents(
  client: WCLClient,
  code: string,
  fight: ReportFight,
): Promise<PrescienceBuffEvent[]> {
  const buffs: PrescienceBuffEvent[] = [];
  let startTime = fight.startTime;

  for (let page = 0; page < 10; page += 1) {
    const data = await client.request<PrescienceBuffsResponse>(PRESCIENCE_BUFFS_QUERY, {
      code,
      fightId: fight.id,
      startTime,
      endTime: fight.endTime,
    });

    const events = data.reportData.report?.events;
    if (!events?.data) break;

    events.data.forEach((event) => {
      if (event.abilityGameID != null && event.abilityGameID !== PRESCIENCE_BUFF_ID) return;
      if (event.type && event.type !== 'applybuff' && event.type !== 'refreshbuff') return;
      if (typeof event.timestamp !== 'number' || !event.targetID) return;
      buffs.push({
        timestamp: event.timestamp,
        ...(event.sourceID ? { sourceID: event.sourceID } : {}),
        targetID: event.targetID,
      });
    });

    if (events.nextPageTimestamp == null || events.nextPageTimestamp <= startTime) break;
    startTime = events.nextPageTimestamp;
  }

  return buffs;
}

export type ActorLookup = {
  id: number;
  name: string;
  server?: string;
  /** WCL actor type: "Player", "NPC" or "Pet". */
  type?: string;
  /** True when WCL lists the actor as a player (players table or actor type). */
  isPlayer?: boolean;
  /** Class name (e.g. "Death Knight") when WCL classified the actor as a player. */
  class?: string;
  /** Spec names seen in `playerDetails`, e.g. `["Augmentation"]`. */
  specs?: string[];
  /** Stable-ish key for grouping across fights: `name@server`. */
  key: string;
};

/**
 * True for a player who played Augmentation Evoker in this report.
 *
 * A player with more than one spec in the report counts as Augmentation; the
 * filter is intentionally coarse so alts swapping specs don't leak through.
 */
export function isAugmentationEvoker(
  actor: Pick<ActorLookup, 'class' | 'specs'>,
): boolean {
  return (
    actor.class?.toLowerCase() === 'evoker' &&
    (actor.specs ?? []).some((spec) => spec.toLowerCase() === 'augmentation')
  );
}

/**
 * Builds the actor id -> name map.
 *
 * `masterData.actors` is the reliable source (includes pets and NPCs);
 * `playerDetails` is the reliable source for "is this a player, what realm and
 * which specs".
 */
export function buildActorLookup(meta: ReportMeta): Map<number, ActorLookup> {
  const lookup = new Map<number, ActorLookup>();
  const players = new Map(meta.players.map((player) => [player.id, player]));

  const add = (
    id: number,
    name: string,
    server?: string,
    actorType?: string,
    actorClass?: string,
    specs?: string[],
  ) => {
    const existing = lookup.get(id);
    const player = players.get(id);
    const resolvedServer = server ?? existing?.server ?? player?.server;
    const resolvedType = actorType ?? existing?.type;
    const resolvedClass = actorClass ?? existing?.class ?? player?.type;
    const resolvedSpecs = specs ?? existing?.specs ?? player?.specs?.map((entry) => entry.spec);

    lookup.set(id, {
      id,
      name,
      ...(resolvedServer ? { server: resolvedServer } : {}),
      ...(resolvedType ? { type: resolvedType } : {}),
      isPlayer: resolvedType === 'Player' || Boolean(player),
      ...(resolvedClass ? { class: resolvedClass } : {}),
      ...(resolvedSpecs?.length ? { specs: resolvedSpecs } : {}),
      key: `${name.toLowerCase()}@${(resolvedServer ?? '').toLowerCase()}`,
    });
  };

  meta.actors.forEach((actor) =>
    add(
      actor.id,
      actor.name,
      actor.server,
      actor.type,
      actor.type === 'Player' ? actor.subType : undefined,
    ),
  );
  meta.players.forEach((player) =>
    add(
      player.id,
      player.name,
      player.server,
      undefined,
      player.type,
      player.specs?.map((entry) => entry.spec),
    ),
  );

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
