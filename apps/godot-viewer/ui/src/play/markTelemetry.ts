/**
 * `mark_dropped` for marks made in the game. F8 with the game focused never
 * passes through the page: the addon tells the backend, which counts those
 * marks apart from the toolbar's (`session.f8Marks`, `live.rs`). So the page
 * fires one event for each step the count takes between two polls. The
 * pane's own marks, F8 with the pane focused and the Mark button, fire where
 * they are made, in `PlayMode.tsx`'s `doMark`.
 */

/** The game's marks counted so far, and the run whose session they are in. */
export interface MarkCount {
  run: number;
  count: number;
}

/**
 * What to keep after a poll, and how many marks to report. A pane that has
 * just opened takes the count it finds as its start: those marks were made
 * before it was looking, and another pane may already have reported them. A
 * run it has not counted before starts from none, so a mark made before that
 * run's first poll still counts.
 */
export function newF8Marks(
  prev: MarkCount | null,
  run: number,
  count: number,
  opening: boolean,
): { next: MarkCount; report: number } {
  const next = { run, count };
  if (opening) return { next, report: 0 };
  const before = prev?.run === run ? prev.count : 0;
  return { next, report: Math.max(0, count - before) };
}
