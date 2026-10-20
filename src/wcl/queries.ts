import type { EncounterRankings, PlayerDetailsData, ReportActor, ReportFight, ReportMeta } from './types.ts';

/**
 * Report metadata + every fight + actor table, in one request.
 *
 * `playerDetails` is a JSON scalar: you select `data` and nothing deeper.
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
        playerDetails(startTime: 0, endTime: 2147483647) {
          data
        }
      }
    }
  }
`;

export type ReportMetaResponse = {
  reportData: {
    report:
      | (Omit<ReportMeta, 'actors' | 'players'> & {
          masterData: { actors: ReportActor[] };
          playerDetails: { data: PlayerDetailsData };
        })
      | null;
  };
};

export function flattenPlayerDetails(data: PlayerDetailsData | undefined) {
  if (!data?.playerDetails) return [];
  const { tanks = [], healers = [], dps = [] } = data.playerDetails;
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
        ) {
          total
          entries {
            id
            total
          }
        }`,
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

export type DamageWindowsResponse = {
  reportData: {
    report:
      | (Record<string, { total: number; entries: { id: number; total: number }[] } | null> & {
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
