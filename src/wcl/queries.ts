import type {
  DamageTableEntry,
  EncounterRankings,
  PlayerDetailsData,
  ReportActor,
  ReportFight,
  ReportMeta,
} from './types.ts';

/**
 * Report metadata + every fight + actor table, in one request.
 *
 * `playerDetails` is a JSON scalar: it takes no sub-selection at all (adding
 * `{ data }` is a GraphQL error). The scalar's value is
 * `{ data: { playerDetails: { tanks, healers, dps } } }` — see `PlayerDetailsData`.
 * `endTime: 2147483647` is the max int, i.e. "whole report" — WCL rejects
 * open-ended ranges on this field.
 */
export const REPORT_META_QUERY = /* GraphQL */ `
  query ReportMeta($code: String!) {
    reportData {
      report(code: $code) {
        code
        title
        startTime
        endTime
        region {
          slug
          name
        }
        zone {
          id
          name
        }
        fights {
          id
          encounterID
          name
          difficulty
          kill
          startTime
          endTime
          fightPercentage
          bossPercentage
          friendlyPlayers
          phaseTransitions {
            id
            startTime
          }
        }
        masterData {
          actors {
            id
            name
            type
            subType
            server
          }
        }
        playerDetails(startTime: 0, endTime: 2147483647)
      }
    }
  }
`;

export type ReportMetaResponse = {
  reportData: {
    report:
      | (Omit<ReportMeta, 'actors' | 'players'> & {
          masterData: { actors: ReportActor[] };
          playerDetails: PlayerDetailsData | null;
        })
      | null;
  };
};

/** `report.playerDetails` is a JSON scalar: `{ data: { playerDetails } }`. */
export function flattenPlayerDetails(details: PlayerDetailsData | null | undefined) {
  const grouped = details?.data?.playerDetails ?? details?.playerDetails;
  if (!grouped) return [];
  const { tanks = [], healers = [], dps = [] } = grouped;
  return [...tanks, ...healers, ...dps];
}

/** Only real encounters, and only fights where WCL could compute a percentage. */
export function isAnalyzableFight(fight: ReportFight): boolean {
  return fight.encounterID !== 0 && typeof fight.fightPercentage === 'number';
}

/**
 * Builds one query containing N `table(...)` aliases.
 *
 * Why table aliases instead of N requests: a GraphQL response can carry many
 * aliased fields, so we get every window of a fight in a single HTTP call.
 * Keep the batch small (20-25) — each `table` is a separate WCL query internally
 * and large batches blow past the complexity limit / hourly points.
 *
 * `startTime`/`endTime` are absolute report times, so the caller must pass
 * `fight.startTime + offset`.
 *
 * `table` is also a JSON scalar, so each alias is selected with no sub-selection.
 * Its value is `{ data: { total, entries: [{ id, total }] } }` — see
 * `DamageTableJson`.
 */
export function buildDamageWindowsQuery(
  ranges: { startTime: number; endTime: number }[],
  hasFilter: boolean,
): string {
  const aliases = ranges
    .map(
      (range, index) => `
        w${index}: table(
          fightIDs: [$fightId]
          startTime: ${Math.round(range.startTime)}
          endTime: ${Math.round(range.endTime)}
          dataType: DamageDone
          ${hasFilter ? 'filterExpression: $filter' : ''}
        )`,
    )
    .join('\n');

  return /* GraphQL */ `
    query DamageWindows($code: String!, $fightId: Int!${hasFilter ? ', $filter: String' : ''}) {
      reportData {
        report(code: $code) {
          fights(fightIDs: [$fightId]) {
            id
            encounterID
            difficulty
            kill
            startTime
            endTime
          }
          ${aliases}
        }
      }
    }
  `;
}

/** `table(...)` JSON scalar value: `{ data: { total, entries } }`. */
export type DamageTableJson = {
  data?: { total?: number; entries?: DamageTableEntry[] };
  /** Fallback for payloads that omit the `data` wrapper. */
  total?: number;
  entries?: DamageTableEntry[];
};

export type DamageWindowsResponse = {
  reportData: {
    report:
      | (Record<string, DamageTableJson | null> & {
          fights: ReportFight[];
        })
      | null;
  };
};

/**
 * `encounterRankings` is also a JSON scalar. One call returns the character's
 * best parse for that encounter/difficulty/partition, including the report code
 * and fight ID we need in order to read the actual fight.
 */
export const CHARACTER_RANKINGS_QUERY = /* GraphQL */ `
  query CharacterRankings(
    $name: String!
    $serverSlug: String!
    $serverRegion: String!
    $encounterID: Int!
    $difficulty: Int!
    $specName: String
    $partition: Int
  ) {
    characterData {
      character(
        name: $name
        serverSlug: $serverSlug
        serverRegion: $serverRegion
      ) {
        id
        name
        classID
        encounterRankings(
          encounterID: $encounterID
          difficulty: $difficulty
          specName: $specName
          partition: $partition
        )
      }
    }
  }
`;

export type CharacterRankingsResponse = {
  characterData: {
    character: {
      id: number;
      name: string;
      classID: number;
      encounterRankings: EncounterRankings | null;
    } | null;
  };
};
