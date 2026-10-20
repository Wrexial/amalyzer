import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateDamage } from '../src/analysis/aggregate.ts';
import { buildAssignments, topEntries } from '../src/analysis/rank.ts';
import { buildWindows } from '../src/analysis/windows.ts';
import type { ActorLookup } from '../src/wcl/report.ts';

const lookup = new Map<number, ActorLookup>([
  [1, { id: 1, name: 'Alpha', key: 'alpha@' }],
  [2, { id: 2, name: 'Beta', key: 'beta@' }],
  [3, { id: 3, name: 'Gamma', key: 'gamma@' }],
]);

const windows = buildWindows(12_000);
const aggregated = aggregateDamage(
  [
    {
      windows,
      damage: [
        {
          windowIndex: 0,
          entries: [
            { id: 1, total: 300 },
            { id: 2, total: 200 },
            { id: 3, total: 100 },
          ],
        },
      ],
    },
  ],
  lookup,
);

test('assignments pick by damage when there is no priority', () => {
  const [assignment] = buildAssignments(aggregated, { slots: 2 });
  assert.deepEqual(
    assignment!.slots.map((slot) => slot.name),
    ['Alpha', 'Beta'],
  );
});

test('priority goes first, in the given order, and is flagged', () => {
  const [assignment] = buildAssignments(aggregated, {
    slots: 2,
    priority: ['gamma@', null, 'alpha@'],
  });

  assert.deepEqual(
    assignment!.slots.map((slot) => [slot.name, slot.priority]),
    [
      ['Gamma', true],
      ['Alpha', true], // fills the last slot even though Beta out-damages it
    ],
  );
});

test('priority entries without data are still emitted', () => {
  const [assignment] = buildAssignments(aggregated, {
    slots: 3,
    priority: ['unknown@'],
  });

  assert.equal(assignment!.slots[0]!.name, 'unknown');
  assert.equal(assignment!.slots[0]!.average, 0);
  assert.equal(assignment!.slots.length, 3);
});

test('exclusions never appear', () => {
  const [assignment] = buildAssignments(aggregated, {
    slots: 3,
    excluded: ['alpha@'],
  });

  assert.deepEqual(
    assignment!.slots.map((slot) => slot.name),
    ['Beta', 'Gamma'],
  );
});

test('topEntries respects its limit', () => {
  assert.equal(topEntries(aggregated[0]!, 2).length, 2);
});

test('a forced Prescience target outside the top N takes the last slot', () => {
  const [assignment] = buildAssignments(aggregated, {
    slots: 2,
    forcedByIndex: new Map([[0, 'gamma@']]),
  });

  assert.deepEqual(
    assignment!.slots.map((slot) => slot.name),
    ['Alpha', 'Gamma'],
  );
});

test('a forced Prescience target already in the top N is not duplicated', () => {
  const [assignment] = buildAssignments(aggregated, {
    slots: 2,
    forcedByIndex: new Map([[0, 'beta@']]),
  });

  assert.deepEqual(
    assignment!.slots.map((slot) => slot.name),
    ['Alpha', 'Beta'],
  );
});
