/**
 * Ability filters applied inside the WCL query, not after the fact.
 *
 * Filtering server-side matters: `table` is computed per ability, and every
 * ability you leave in inflates the query's point cost.
 *
 * The lists below are carried over from the Augmentator3000 implementation
 * (which in turn sources them from WoWAnalyzer/simc). They encode "damage that
 * does not scale with Augmentation buffs", which is exactly what you want to
 * exclude when deciding who to buff.
 */

/** Abilities that are flat-out not attributable to a player's own performance. */
export const ABILITY_BLACKLIST: number[] = [
  98021, // Spirit Link Totem
  201657, // Earthen Wall Totem
  425610, // Empowering Flame
];

/** Non-class sources (trinkets, enchants, cantrips) with no main-stat scaling. */
export const ABILITY_NO_BOE_SCALING: number[] = [
  409632, // Breath of Eons
  442280, 442801, 443102, 443124, 443387, 443473, 443539, 443585, 443664,
  443796, 444264, 444301, 444409, 444466, 444628, 444670, 445434, 445475,
  445628, 446224, 446402, 446811, 447093, 447471, 447495, 447595, 447596,
  448001, 448090, 448519, 448669, 448744, 448862, 448892, 448909, 449024,
  449217, 449386, 449828, 449885, 449886, 449892, 450003, 450119, 450151,
  450158, 450162, 450340, 450429, 450721, 450921, 450926, 450928, 450960,
  450969, 451015, 451292, 451866, 451905, 451910, 451911, 451929, 451930,
  451931, 452032, 452229, 452334, 452335, 452380, 452445, 452545, 452767,
  452800, 452804, 452831, 452832, 452833, 452872, 452890, 453039, 453377,
  453437, 453510, 453782, 454349, 454354, 454356, 454558, 454857, 455214,
  455328, 455335, 455433, 455434, 455443, 455447, 455467, 455471, 455479,
  455480, 455486, 455487, 455536, 455537, 455654, 455821, 455910, 456830,
  457737, 457740, 457742, 457768, 457928, 458144, 458421, 458573, 458624,
  458938, 458940, 458944, 458946, 458950, 458952, 459264, 459267, 460074,
  460076, 460909, 461185, 461190, 461191, 461192, 461193, 463003, 463095,
  463108, 463610,
];

/** `ability.id NOT IN (1, 2, 3)` — empty string when there is nothing to exclude. */
export function notInFilter(abilityIds: number[]): string {
  if (!abilityIds.length) return '';
  return `ability.id NOT IN (${abilityIds.join(', ')})`;
}

/** The filter Augmentator uses by default. */
export const DEFAULT_DAMAGE_FILTER = notInFilter([
  ...ABILITY_BLACKLIST,
  ...ABILITY_NO_BOE_SCALING,
]);
