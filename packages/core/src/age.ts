/**
 * Recency, bucketed the way a person thinks about it rather than on a linear clock. A
 * linear ramp would spend almost all of its range on the years and leave "today" and
 * "last week" the same colour, which are exactly the two a person looking for what just
 * changed needs told apart.
 */
const DAY = 86_400_000;

export type AgeBucket = {
  /** Short name for a legend row. */
  label: string;
  /** Anything younger than this falls in the bucket; the last one takes the rest. */
  under: number;
};

export const AGE_BUCKETS: readonly AgeBucket[] = [
  { label: "Today", under: DAY },
  { label: "This week", under: 7 * DAY },
  { label: "This month", under: 31 * DAY },
  { label: "This year", under: 365 * DAY },
  { label: "1–3 years", under: 3 * 365 * DAY },
  { label: "Older", under: Number.POSITIVE_INFINITY },
];

/**
 * Which of `AGE_BUCKETS` a modification time falls in, measured back from `now`, or null
 * when there is no time to go on. A time in the future — a clock skewed between machines,
 * or a file stamped by something that did not care — counts as today rather than
 * as unknown: it was certainly touched recently by somebody's reckoning.
 */
export function ageBucketIndex(modified: number | undefined, now: number): number | null {
  if (modified === undefined || !Number.isFinite(modified) || modified <= 0) return null;
  const age = Math.max(0, now - modified);
  const index = AGE_BUCKETS.findIndex((bucket) => age < bucket.under);
  return index === -1 ? AGE_BUCKETS.length - 1 : index;
}
