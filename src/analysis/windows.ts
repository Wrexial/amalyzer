import type { TimeWindow } from '../wcl/types.ts';

export type WindowOptions = {
  /** Width of a window. Default 6000ms (one Ebon Might tick). */
  sizeMs?: number;
  /**
   * The first window starts later than the fight start, because nothing useful
   * happens in the first seconds of a pull. Default 4000ms.
   *
   * Note the grid stays anchored to the fight start: window N always begins at
   * `N * sizeMs`, and only window 0 is clipped by the offset. That is what makes
   * window N comparable across different fights.
   */
  offsetMs?: number;
  /** Hard cap, useful to keep the query count sane on very long fights. */
  maxWindows?: number;
};

/**
 * Slices a fight of `durationMs` into windows.
 *
 * With defaults and a 20s fight you get:
 *   [4000, 5999] [6000, 11999] [12000, 17999] [18000, 19999]
 * which matches Augmentator3000's `generateTimeRanges`.
 */
export function buildWindows(durationMs: number, options: WindowOptions = {}): TimeWindow[] {
  const sizeMs = options.sizeMs ?? 6000;
  const offsetMs = options.offsetMs ?? 4000;

  if (sizeMs <= 0) throw new Error('sizeMs must be > 0');

  const windows: TimeWindow[] = [];

  for (let cursor = 0; cursor < durationMs; cursor += sizeMs) {
    const startTime = cursor === 0 ? offsetMs : cursor;
    const endTime = Math.min(cursor + sizeMs - 1, durationMs - 1);

    // Fight shorter than the offset: nothing to analyse.
    if (startTime > endTime) continue;

    windows.push({ index: windows.length, startTime, endTime });

    if (options.maxWindows != null && windows.length >= options.maxWindows) break;
  }

  return windows;
}

/** Shifts fight-relative windows into report time (what the WCL query needs). */
export function toReportTime(windows: TimeWindow[], fightStartTime: number): TimeWindow[] {
  return windows.map((window) => ({
    index: window.index,
    startTime: window.startTime + fightStartTime,
    endTime: window.endTime + fightStartTime,
  }));
}

export function windowDurationMs(window: TimeWindow): number {
  return window.endTime - window.startTime + 1;
}
