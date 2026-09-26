import { describe, expect, it } from "vitest";
import { dailyLogs, uplinkJournal } from "./logs";

describe("generated logs", () => {
  it("writes four weeks of daily logs, oldest first, ending on the field-notes date", () => {
    const logs = dailyLogs();

    expect(logs).toHaveLength(28);
    expect(new Set(logs.map((log) => log.name)).size).toBe(28);
    expect(logs.map((log) => log.date)).toEqual([...logs.map((log) => log.date)].sort());
    expect(logs.at(-1)).toMatchObject({ name: "console-2026-08-11.log", ageDays: 0 });
  });

  it("keeps each day's lines in time order", () => {
    for (const log of dailyLogs()) {
      const times = log.content.split("\n").filter((line) => /^\d{4}-/.test(line)).map((line) => line.slice(11, 16));
      expect(times).toEqual([...times].sort());
    }
  });

  it("threads the story through the routine chatter", () => {
    const last = dailyLogs().at(-1)!.content;

    expect(last).toContain("unknown.pkg");
    expect(dailyLogs().some((log) => log.content.includes("voice-memo.wav"))).toBe(true);
  });

  it("reads the same on every visit", () => {
    expect(dailyLogs()).toEqual(dailyLogs());
    expect(uplinkJournal()).toBe(uplinkJournal());
  });

  it("writes one parseable JSON object per line in the uplink journal", () => {
    const lines = uplinkJournal().trim().split("\n");

    expect(lines.length).toBeGreaterThan(10);
    expect(lines.map((line) => JSON.parse(line).link)).toContain("DEGRADED");
  });
});
