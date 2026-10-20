import assert from 'node:assert/strict';
import test from 'node:test';

import { parseReportInput } from '../src/wcl/report.ts';
import { buildDamageWindowsQuery } from '../src/wcl/queries.ts';

test('parses a bare report code', () => {
  assert.deepEqual(parseReportInput('AbCdEfGh1234'), {
    code: 'AbCdEfGh1234',
    fightId: undefined,
  });
});

test('parses a full report url with query params', () => {
  const parsed = parseReportInput(
    'https://www.warcraftlogs.com/reports/AbCdEfGh1234?fight=5&type=damage-done',
  );
  assert.equal(parsed.code, 'AbCdEfGh1234');
  assert.equal(parsed.fightId, 5);
});

test('parses hash-style urls and fight=last', () => {
  const parsed = parseReportInput('https://classic.warcraftlogs.com/reports/XyZ987#fight=last&type=summary');
  assert.equal(parsed.code, 'XyZ987');
  assert.equal(parsed.fightId, 'last');
});

test('tolerates trailing slashes', () => {
  assert.equal(parseReportInput('https://www.warcraftlogs.com/reports/AbCdEfGh1234/').code, 'AbCdEfGh1234');
});

test('window query emits one alias per window and only includes filter when asked', () => {
  const ranges = [
    { startTime: 4000, endTime: 5999 },
    { startTime: 6000, endTime: 11_999 },
  ];

  const query = buildDamageWindowsQuery(ranges, true);
  assert.match(query, /w0: table\(/);
  assert.match(query, /w1: table\(/);
  assert.match(query, /startTime: 4000/);
  assert.match(query, /filterExpression: \$filter/);
  assert.match(query, /\$filter: String/);

  const unfiltered = buildDamageWindowsQuery(ranges, false);
  assert.doesNotMatch(unfiltered, /filterExpression/);
  assert.doesNotMatch(unfiltered, /\$filter/);
});

test('support table is filtered by buff, caster and supported actor', () => {
  const query = buildDamageWindowsQuery(
    [
      {
        startTime: 1000,
        endTime: 2000,
        support: { abilityId: 413984, sourceId: 7, targetId: 9 },
      },
    ],
    false,
  );

  assert.match(query, /s0: table\(/);
  assert.match(query, /abilityID: 413984/);
  assert.match(query, /sourceID: 7/);
  assert.match(query, /supportedActor\.id = 9/);
});
