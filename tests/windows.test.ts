import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPrescienceIntervals,
  buildPrescienceWindows,
  buildWindows,
  toReportTime,
  windowDurationMs,
} from '../src/analysis/windows.ts';

test('windows match Augmentator3000 generateTimeRanges at 6s', () => {
  // Reimplementation of the original loop:
  //   for (i = 0; i < max; i += 6000) { start = i === 0 ? i + 4000 : i; end = i + 5999 }
  const windows = buildWindows(20_000, { sizeMs: 6000 });

  assert.deepEqual(windows, [
    { index: 0, startTime: 4000, endTime: 5999 },
    { index: 1, startTime: 6000, endTime: 11_999 },
    { index: 2, startTime: 12_000, endTime: 17_999 },
    { index: 3, startTime: 18_000, endTime: 19_999 },
  ]);
  assert.equal(windows.length, 4);
});

test('first window is clipped, the grid stays anchored to the fight start', () => {
  // 27s default: window 0 runs 4s..26999, window 1 starts at 27000.
  const windows = buildWindows(60_000);
  assert.equal(windowDurationMs(windows[0]!), 23_000);
  assert.equal(windowDurationMs(windows[1]!), 27_000);
  assert.equal(windows[1]!.startTime, 27_000);
});

test('fight shorter than the offset yields nothing', () => {
  assert.deepEqual(buildWindows(3000), []);
});

test('maxWindows caps the grid without shifting it', () => {
  const windows = buildWindows(60_000, { maxWindows: 2 });
  assert.deepEqual(
    windows.map((window) => window.startTime),
    [4000, 27_000],
  );
});

test('prescience intervals run from each cast to the next, last to fight end', () => {
  const windows = buildPrescienceIntervals([100_000, 106_000, 118_000], 100_000, 60_000);

  assert.deepEqual(windows, [
    { index: 0, startTime: 0, endTime: 5_999 },
    { index: 1, startTime: 6_000, endTime: 17_999 },
    { index: 2, startTime: 18_000, endTime: 59_999 },
  ]);
});

test('prescience intervals dedupe and ignore out-of-fight casts', () => {
  const windows = buildPrescienceIntervals([160_000, 100_000, 100_000], 100_000, 20_000);

  assert.deepEqual(windows, [{ index: 0, startTime: 0, endTime: 19_999 }]);
});

test('prescience windows start at each cast and last the buff duration', () => {
  const windows = buildPrescienceWindows([100_000, 106_000, 118_000], 100_000, 60_000, 18_000);

  assert.deepEqual(windows, [
    { index: 0, startTime: 0, endTime: 17_999 },
    { index: 1, startTime: 6_000, endTime: 23_999 },
    { index: 2, startTime: 18_000, endTime: 35_999 },
  ]);
});

test('prescience windows are sorted, deduplicated and clipped to the fight', () => {
  const windows = buildPrescienceWindows([112_000, 100_000, 100_000], 100_000, 20_000, 18_000);

  assert.deepEqual(windows, [
    { index: 0, startTime: 0, endTime: 17_999 },
    { index: 1, startTime: 12_000, endTime: 19_999 },
  ]);
});

test('toReportTime shifts into report time', () => {
  const windows = buildWindows(12_000, { sizeMs: 6000 });
  const shifted = toReportTime(windows, 500_000);
  assert.equal(shifted[0]!.startTime, 504_000);
  assert.equal(shifted[1]!.endTime, 511_999);
  assert.equal(shifted[1]!.index, 1);
});
