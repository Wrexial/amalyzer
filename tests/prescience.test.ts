import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPrescienceApplications,
  matchPrescienceRecipients,
} from '../src/wcl/prescience.ts';

test('tracks an application until removebuff', () => {
  const applications = buildPrescienceApplications(
    [
      { timestamp: 1000, type: 'applybuff', sourceID: 10, targetID: 2 },
      { timestamp: 19_000, type: 'removebuff', sourceID: 10, targetID: 2 },
    ],
    60_000,
    18_000,
  );

  assert.deepEqual(applications, [
    { timestamp: 1000, endTimestamp: 19_000, sourceID: 10, targetID: 2 },
  ]);
});

test('a refresh starts a new window but shares the aura end', () => {
  const applications = buildPrescienceApplications(
    [
      { timestamp: 1000, type: 'applybuff', sourceID: 10, targetID: 2 },
      { timestamp: 6000, type: 'refreshbuff', sourceID: 10, targetID: 2 },
      { timestamp: 25_000, type: 'removebuff', sourceID: 10, targetID: 2 },
    ],
    40_000,
    18_000,
  );

  assert.deepEqual(applications, [
    { timestamp: 1000, endTimestamp: 25_000, sourceID: 10, targetID: 2 },
    { timestamp: 6000, endTimestamp: 25_000, sourceID: 10, targetID: 2 },
  ]);
});

test('a refresh without a removal uses the fallback from the last start', () => {
  const applications = buildPrescienceApplications(
    [
      { timestamp: 1000, type: 'applybuff', sourceID: 10, targetID: 2 },
      { timestamp: 6000, type: 'refreshbuff', sourceID: 10, targetID: 2 },
    ],
    40_000,
    18_000,
  );

  assert.deepEqual(
    applications.map((application) => application.endTimestamp),
    [24_000, 24_000],
  );
});

test('an application with no removal is capped by fight end or the fallback', () => {
  const [application] = buildPrescienceApplications(
    [{ timestamp: 1000, type: 'applybuff', sourceID: 10, targetID: 2 }],
    10_000,
    18_000,
  );

  assert.equal(application!.endTimestamp, 10_000);
});

test('attributes an enemy-targeted cast to the buff application', () => {
  const matched = matchPrescienceRecipients(
    [{ timestamp: 1000, targetID: 99 }],
    [{ timestamp: 1002, endTimestamp: 19_002, targetID: 2 }],
  );

  assert.deepEqual(matched, [
    {
      timestamp: 1000,
      targetID: 99,
      recipientID: 2,
      applicationEndTimestamp: 19_002,
    },
  ]);
});

test('leaves casts without a nearby application unmatched', () => {
  const matched = matchPrescienceRecipients(
    [{ timestamp: 1000, targetID: 99 }],
    [{ timestamp: 2000, endTimestamp: 20_000, targetID: 2 }],
  );

  assert.deepEqual(matched, [{ timestamp: 1000, targetID: 99 }]);
});

test('consumes each application once for simultaneous casts', () => {
  const matched = matchPrescienceRecipients(
    [
      { timestamp: 1000, targetID: 99 },
      { timestamp: 1000, targetID: 99 },
    ],
    [
      { timestamp: 1000, endTimestamp: 19_000, targetID: 2 },
      { timestamp: 1001, endTimestamp: 19_001, targetID: 3 },
    ],
  );

  assert.deepEqual(
    matched.map((cast) => cast.recipientID),
    [2, 3],
  );
});

test('picks the nearest application within tolerance', () => {
  const matched = matchPrescienceRecipients(
    [{ timestamp: 1000 }],
    [
      { timestamp: 1010, endTimestamp: 19_010, targetID: 2 },
      { timestamp: 1004, endTimestamp: 19_004, targetID: 3 },
    ],
    50,
  );

  assert.equal(matched[0]!.recipientID, 3);
});

test("does not pair a cast with another caster's application", () => {
  const matched = matchPrescienceRecipients(
    [{ timestamp: 1000, sourceID: 10, targetID: 99 }],
    [{ timestamp: 1000, endTimestamp: 19_000, sourceID: 20, targetID: 2 }],
  );

  assert.equal(matched[0]!.recipientID, undefined);
});

test("prefers the application on the cast's own target", () => {
  const matched = matchPrescienceRecipients(
    [{ timestamp: 1000, targetID: 2 }],
    [
      { timestamp: 1000, endTimestamp: 5000, targetID: 3 },
      { timestamp: 1020, endTimestamp: 19_020, targetID: 2 },
    ],
  );

  assert.equal(matched[0]!.recipientID, 2);
  assert.equal(matched[0]!.applicationEndTimestamp, 19_020);
});
