import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateDamage, damagePerSecond, type FightDamageInput } from '../src/analysis/aggregate.ts';
import { buildWindows } from '../src/analysis/windows.ts';
import type { ActorLookup } from '../src/wcl/report.ts';

const lookup = new Map<number, ActorLookup>([
  [1, { id: 1, name: 'Alpha', server: 'Tarren Mill', key: 'alpha@tarren mill' }],
  [2, { id: 2, name: 'Beta', server: 'Tarren Mill', key: 'beta@tarren mill' }],
  [3, { id: 3, name: 'Pet', key: 'pet@' }],
]);

const windows = buildWindows(12_000);

const fightA: FightDamageInput = {
  windows,
  damage: [
    { windowIndex: 0, entries: [{ id: 1, total: 100 }, { id: 2, total: 0 }] },
    { windowIndex: 1, entries: [{ id: 1, total: 300 }, { id: 2, total: 200 }] },
  ],
};

const fightB: FightDamageInput = {
  windows,
  damage: [{ windowIndex: 0, entries: [{ id: 2, total: 50 }] }],
};

test('averages per window, dropping zero samples', () => {
  const result = aggregateDamage([fightA, fightB], lookup);

  assert.equal(result.length, 2);

  const first = result[0]!;
  assert.equal(first.window.startTime, 4000);
  assert.deepEqual(
    first.entries.map((entry) => [entry.actor.name, entry.average, entry.count]),
    [
      ['Alpha', 100, 1], // Beta reported 0 in this window and was not counted
      ['Beta', 50, 1],
    ],
  );

  const second = result[1]!;
  assert.deepEqual(
    second.entries.map((entry) => [entry.actor.name, entry.average]),
    [
      ['Alpha', 300],
      ['Beta', 200],
    ],
  );
});

test('same actor across fights: total sums, count only increments on contribution', () => {
  const fightC: FightDamageInput = {
    windows,
    damage: [{ windowIndex: 0, entries: [{ id: 1, total: 300 }] }],
  };

  const first = aggregateDamage([fightA, fightC], lookup)[0]!;
  const alpha = first.entries.find((entry) => entry.actor.name === 'Alpha')!;

  assert.equal(alpha.total, 400);
  assert.equal(alpha.count, 2);
  assert.equal(alpha.average, 200);
});

test('unknown actor ids are ignored', () => {
  const result = aggregateDamage(
    [{ windows, damage: [{ windowIndex: 0, entries: [{ id: 999, total: 10_000 }] }] }],
    lookup,
  );
  assert.deepEqual(result, []);
});

test('dps accounts for the clipped first window', () => {
  const result = aggregateDamage([fightA], lookup);
  const alpha = result[0]!.entries[0]!;

  // 100 damage over a 2s window.
  assert.equal(damagePerSecond(alpha, result[0]!.window), 50);
});
