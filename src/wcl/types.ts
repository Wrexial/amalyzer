/**
 * Warcraft Logs v2 API surface that we actually use.
 * Docs: https://www.warcraftlogs.com/v2-api-docs/warcraft/
 *
 * Everything here is intentionally permissive (`unknown` / loose shapes) because
 * WCL returns JSON scalars for a few fields (notably `playerDetails`, `table`
 * and `encounterRankings`) and adds fields without notice.
 */

export type WCLCredentials = {
  clientId: string;
  clientSecret: string;
};

export type ReportFight = {
  id: number;
  encounterID: number;
  name: string;
  difficulty: number;
  kill: boolean;
  /** Milliseconds since report start. All WCL fight times are relative to the report. */
  startTime: number;
  endTime: number;
  fightPercentage: number | null;
  bossPercentage: number | null;
  /** Actor IDs of players in the fight (not names). */
  friendlyPlayers: number[];
  phaseTransitions: { id: number; startTime: number }[];
};

/** From `report.masterData.actors` — covers players, pets and NPCs. */
export type ReportActor = {
  id: number;
  name: string;
  type: string;
  subType?: string;
  /** Actor id of the owner when this actor is a pet/summon. */
  petOwner?: number;
  server?: string;
};

export type PlayerDetailsEntry = {
  id: number;
  name: string;
  server?: string;
  type: string;
  specs?: { spec: string; count: number }[];
};

export type PlayerDetailsGroups = {
  tanks: PlayerDetailsEntry[];
  healers: PlayerDetailsEntry[];
  dps: PlayerDetailsEntry[];
};

/**
 * Value of the `report.playerDetails` JSON scalar. WCL wraps it in a `data`
 * object; `playerDetails` directly on the value is tolerated as a fallback.
 */
export type PlayerDetailsData = {
  data?: { playerDetails?: PlayerDetailsGroups };
  playerDetails?: PlayerDetailsGroups;
};

export type ReportMeta = {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  region: { slug: string; name: string };
  zone: { id: number; name: string } | null;
  fights: ReportFight[];
  actors: ReportActor[];
  /** Same actors, but only the ones WCL classified as players for the report. */
  players: PlayerDetailsEntry[];
};

export type DamageTableEntry = {
  id: number;
  total: number;
};

export type DamageTable = {
  total: number;
  entries: DamageTableEntry[];
} | null;

/** A single `table(...)` result for one fight and one time slice. */
export type WindowDamage = {
  /** Index into the window grid, not a timestamp. */
  windowIndex: number;
  entries: DamageTableEntry[];
};

export type EncounterRank = {
  lockedIn: boolean;
  rankPercent: number;
  historicalPercent: number;
  todayPercent: number;
  rankTotalParses: number;
  guild: { id: number; name: string; faction: number };
  report: { code: string; startTime: number; fightID: number };
  duration: number;
  /** Absolute time in the report where the kill started. */
  startTime: number;
  amount: number;
  spec: string;
  bestSpec: string;
  class: number;
};

export type EncounterRankings = {
  averagePerformance: number;
  bestAmount: number;
  difficulty: number;
  fastestKill: number;
  medianPerformance: number;
  metric: string;
  partition: number;
  totalKills: number;
  zone: number;
  ranks: EncounterRank[];
};

/** Absolute (report-time) time slice. `endTime` is inclusive, matching WCL. */
export type TimeWindow = {
  index: number;
  startTime: number;
  endTime: number;
};
