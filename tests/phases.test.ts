import assert from 'node:assert/strict';
import test from 'node:test';

import { fightPhases, phaseAt, referenceFight } from '../src/analysis/phases.ts';

const fight = {
  startTime: 100_000,
  endTime: 400_000,
  phaseTransitions: [
    { id: 1, startTime: 100_000 },
    { id: 2, startTime: 220_000 },
    { id: 3, startTime: 310_000 },
  ],
};

test('phase transitions are converted to fight-relative times', () => {
  assert.deepEqual(fightPhases(fight), [
    { id: 1, startTime: 0 },
    { id: 2, startTime: 120_000 },
    { id: 3, startTime: 210_000 },
  ]);
});

test('a missing phase-1 transition is synthesised at zero', () => {
  assert.deepEqual(
    fightPhases({ startTime: 50_000, phaseTransitions: [{ id: 2, startTime: 110_000 }] }),
    [
      { id: 1, startTime: 0 },
      { id: 2, startTime: 60_000 },
    ],
  );
});

test('phaseAt picks the last boundary at or before the window', () => {
  const phases = fightPhases(fight);
  assert.equal(phaseAt(phases, 0)?.id, 1);
  assert.equal(phaseAt(phases, 119_999)?.id, 1);
  assert.equal(phaseAt(phases, 120_000)?.id, 2);
  assert.equal(phaseAt(phases, 999_999)?.id, 3);
  assert.equal(phaseAt([], 0), undefined);
});

test('referenceFight returns the longest fight', () => {
  const short = { startTime: 0, endTime: 100 };
  const long = { startTime: 500, endTime: 1000 };
  assert.equal(referenceFight([short, long]), long);
  assert.equal(referenceFight([]), undefined);
});
