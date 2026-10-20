import assert from 'node:assert/strict';
import test from 'node:test';

import { matchPrescienceRecipients } from '../src/wcl/prescience.ts';

test('attributes an enemy-targeted cast to the buff recipient', () => {
  const matched = matchPrescienceRecipients(
    [{ timestamp: 1000, targetID: 99 }],
    [{ timestamp: 1002, targetID: 2 }],
  );

  assert.deepEqual(matched, [{ timestamp: 1000, targetID: 99, recipientID: 2 }]);
});

test('leaves casts without a nearby buff event unmatched', () => {
  const matched = matchPrescienceRecipients(
    [{ timestamp: 1000, targetID: 99 }],
    [{ timestamp: 2000, targetID: 2 }],
  );

  assert.deepEqual(matched, [{ timestamp: 1000, targetID: 99 }]);
});

test('consumes each buff event once for simultaneous casts', () => {
  const matched = matchPrescienceRecipients(
    [
      { timestamp: 1000, targetID: 99 },
      { timestamp: 1000, targetID: 99 },
    ],
    [
      { timestamp: 1000, targetID: 2 },
      { timestamp: 1001, targetID: 3 },
    ],
  );

  assert.deepEqual(
    matched.map((cast) => cast.recipientID),
    [2, 3],
  );
});

test('picks the nearest buff event within tolerance', () => {
  const matched = matchPrescienceRecipients(
    [{ timestamp: 1000 }],
    [
      { timestamp: 1010, targetID: 2 },
      { timestamp: 1004, targetID: 3 },
    ],
    50,
  );

  assert.equal(matched[0]!.recipientID, 3);
});
