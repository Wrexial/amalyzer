import assert from 'node:assert/strict';
import test from 'node:test';

import { sumSupportByApplication } from '../src/wcl/support.ts';

const applications = [
  { timestamp: 1000, endTimestamp: 6000, sourceID: 10, targetID: 2 },
  { timestamp: 6000, endTimestamp: 20_000, sourceID: 10, targetID: 2 },
  { timestamp: 1000, endTimestamp: 20_000, sourceID: 10, targetID: 3 },
];

test('sums support only for the matching target, caster and application', () => {
  const totals = sumSupportByApplication(
    applications,
    [
      { timestamp: 2000, sourceID: 10, supportID: 2, amount: 100 },
      { timestamp: 7000, sourceID: 10, supportID: 2, amount: 200 },
      { timestamp: 3000, sourceID: 10, supportID: 3, amount: 50 },
      { timestamp: 3000, sourceID: 99, supportID: 2, amount: 999 },
      { timestamp: 500, sourceID: 10, supportID: 2, amount: 999 },
    ],
    0,
  );

  assert.equal(totals.get('1000:2'), 100);
  assert.equal(totals.get('6000:2'), 200);
  assert.equal(totals.get('1000:3'), 50);
  assert.equal(totals.size, 3);
});

test('keeps negative support and separates same-start targets', () => {
  const totals = sumSupportByApplication(
    applications,
    [
      { timestamp: 2000, sourceID: 10, supportID: 2, amount: 100 },
      { timestamp: 2100, sourceID: 10, supportID: 2, amount: -40 },
      { timestamp: 2200, sourceID: 10, supportID: 3, amount: 10 },
    ],
    0,
  );

  assert.equal(totals.get('1000:2'), 60);
  assert.equal(totals.get('1000:3'), 10);
});
