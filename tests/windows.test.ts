import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWindows, toReportTime, windowDurationMs } from '../src/analysis/windows.ts';

test('windows match Augmentator3000 generateTimeRanges', () => {
  // Reimplementation of the original loop:
  //   for (i = 0; i < max; i += 6000) { start = i === 0 ? i + 4000 : i; end = i + 5999 }
  const windows = buildWindows(20_000);

  assert.deepEqual(windows, [
    { index: 0, startTime: 4000, endTime: 5999 },
    { index: 1, startTime: 6000, endTime: 11_999 },
    { index: 2, startTime: 12_000, endTime: 17_999 },
    { index: 3, startTime: 18_000, endTime: 19_999 },
  ]);
  assert.equal(windows.length, 4);
});

test('first window is clipped, the grid stays anchored to the fight start', () => {
  const windows = buildWindows(30_000);
  assert.equal(windowDurationMs(windows[0]!), 2000);
  assert.equal(windowDurationMs(windows[1]!), 6000);
  assert.equal(windows[1]!.startTime, 6000);
});

test('fight shorter than the offset yields nothing', () => {
  assert.deepEqual(buildWindows(3000), []);
});

test('maxWindows caps the grid without shifting it', () => {
  const windows = buildWindows(60_000, { maxWindows: 2 });
  assert.deepEqual(
    windows.map((window) => window.startTime),
    [4000, 6000],
  );
});

test('toReportTime shifts into report time', () => {
  const windows = buildWindows(12_000);
  const shifted = toReportTime(windows, 500_000);
  assert.equal(shifted[0]!.startTime, 504_000);
  assert.equal(shifted[1]!.endTime, 511_999);
  assert.equal(shifted[1]!.index, 1);
});
