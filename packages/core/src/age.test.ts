import { describe, expect, it } from "vitest";
import { AGE_BUCKETS, ageBucketIndex } from "./age";

const now = Date.UTC(2026, 8, 26, 12);
const day = 86_400_000;

describe("ageBucketIndex", () => {
  it("puts something changed an hour ago in the hottest bucket", () => {
    expect(ageBucketIndex(now - 3_600_000, now)).toBe(0);
  });

  it("walks colder through the week, the month and the year", () => {
    expect(AGE_BUCKETS[ageBucketIndex(now - 3 * day, now)!].label).toBe("This week");
    expect(AGE_BUCKETS[ageBucketIndex(now - 20 * day, now)!].label).toBe("This month");
    expect(AGE_BUCKETS[ageBucketIndex(now - 200 * day, now)!].label).toBe("This year");
    expect(AGE_BUCKETS[ageBucketIndex(now - 800 * day, now)!].label).toBe("1–3 years");
  });

  it("gives anything older than the last boundary the coldest bucket", () => {
    expect(ageBucketIndex(now - 40 * 365 * day, now)).toBe(AGE_BUCKETS.length - 1);
  });

  it("reads a timestamp from the future as today, not as unknown", () => {
    expect(ageBucketIndex(now + 5 * day, now)).toBe(0);
  });

  it("has nothing to say without a timestamp", () => {
    expect(ageBucketIndex(undefined, now)).toBeNull();
    expect(ageBucketIndex(0, now)).toBeNull();
  });
});
