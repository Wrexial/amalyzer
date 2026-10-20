import type { WCLClient } from './client.ts';
import { CHARACTER_RANKINGS_QUERY, type CharacterRankingsResponse } from './queries.ts';
import type { EncounterRank, EncounterRankings } from './types.ts';

export type CharacterRef = {
  name: string;
  serverSlug: string;
  serverRegion: string;
};

/**
 * The "best logs" path used by Augmentator: ask WCL for a character's best
 * parse on an encounter, then read that exact report/fight. This gives you a
 * sample of high-quality kills without asking the user for report URLs.
 */
export async function fetchEncounterRankings(
  client: WCLClient,
  character: CharacterRef,
  options: {
    encounterID: number;
    difficulty: number;
    specName?: string;
    partition?: number;
  },
): Promise<{ character: { id: number; name: string; classID: number }; rankings: EncounterRankings }> {
  const data = await client.request<CharacterRankingsResponse>(CHARACTER_RANKINGS_QUERY, {
    name: character.name,
    serverSlug: character.serverSlug,
    serverRegion: character.serverRegion,
    encounterID: options.encounterID,
    difficulty: options.difficulty,
    ...(options.specName ? { specName: options.specName } : {}),
    ...(options.partition ? { partition: options.partition } : {}),
  });

  const found = data.characterData.character;
  if (!found) {
    throw new Error(`Character ${character.name} not found on ${character.serverSlug}-${character.serverRegion}`);
  }
  if (!found.encounterRankings) {
    throw new Error(`No rankings for ${character.name} on encounter ${options.encounterID}`);
  }

  return {
    character: { id: found.id, name: found.name, classID: found.classID },
    rankings: found.encounterRankings,
  };
}

export function bestRank(rankings: EncounterRankings): EncounterRank | null {
  return [...(rankings.ranks ?? [])].sort((a, b) => b.amount - a.amount)[0] ?? null;
}

/** Distinct kill (report, fight) pairs, best amount first. */
export function rankToFightRefs(rankings: EncounterRankings) {
  return [...(rankings.ranks ?? [])]
    .sort((a, b) => b.amount - a.amount)
    .map((rank) => ({
      reportCode: rank.report.code,
      fightId: rank.report.fightID,
      amount: rank.amount,
      duration: rank.duration,
      rankPercent: rank.rankPercent,
      spec: rank.bestSpec || rank.spec,
    }));
}
