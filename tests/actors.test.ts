import assert from 'node:assert/strict';
import test from 'node:test';

import { buildActorLookup, isAugmentationEvoker } from '../src/wcl/report.ts';
import type { ReportMeta } from '../src/wcl/types.ts';

const meta = {
  players: [
    {
      id: 1,
      name: 'Ampersand',
      server: 'Tarren Mill',
      type: 'Evoker',
      specs: [{ spec: 'Augmentation', count: 3 }],
    },
    { id: 2, name: 'Frosty', server: 'Tarren Mill', type: 'Mage' },
  ],
  actors: [
    { id: 1, name: 'Ampersand', type: 'Player', subType: 'Evoker', server: 'Tarren Mill' },
    { id: 2, name: 'Frosty', type: 'Player', subType: 'Mage', server: 'Tarren Mill' },
    { id: 99, name: 'Treant', type: 'Pet', subType: 'Pet', petOwner: 1 },
  ],
} as unknown as ReportMeta;

test('actor lookup carries class and specs', () => {
  const lookup = buildActorLookup(meta);

  assert.equal(lookup.get(1)?.class, 'Evoker');
  assert.deepEqual(lookup.get(1)?.specs, ['Augmentation']);
  assert.equal(lookup.get(2)?.class, 'Mage');
  assert.equal(lookup.get(99)?.class, undefined);
  assert.equal(lookup.get(99)?.isPlayer, false);
  assert.equal(lookup.get(99)?.ownerId, 1);
  assert.equal(lookup.get(1)?.isPlayer, true);
});

test('detects Augmentation Evokers by class + spec', () => {
  const lookup = buildActorLookup(meta);

  assert.equal(isAugmentationEvoker(lookup.get(1)!), true);
  assert.equal(isAugmentationEvoker(lookup.get(2)!), false);
  assert.equal(isAugmentationEvoker({ class: 'Evoker', specs: ['Devastation'] }), false);
  assert.equal(isAugmentationEvoker({ class: 'Evoker' }), false);
});
