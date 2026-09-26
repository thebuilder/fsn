import { seeded, type Random } from "./bytes";

/**
 * The console logs of the machine the demo filesystem belongs to: one file per day
 * for four weeks up to the night the field notes describe.
 *
 * They are generated rather than written out because a district of thirty near-alike
 * files is exactly what makes a real Logs folder look like one, and generated from a
 * seed so every visitor reads the same four weeks. Most lines are routine. A thread
 * of anomalies runs through them — the archive link degrading, a carrier nobody can
 * place, something writing to Downloads at night — and ends where the rest of the
 * demo picks the story up.
 */

export type DailyLog = { name: string; date: string; content: string; ageDays: number };

/** The last day logged, which is also the date on the field notes. */
const LAST_DAY = Date.UTC(2026, 7, 11);
const DAYS = 28;
const DAY_MS = 86_400_000;

/** Everyday chatter; each line draws its own numbers so they stay in believable ranges. */
const ROUTINE: Array<[string, (random: Random) => string]> = [
  ["NAV", (random) => `district cache warm, ${16 + random.int(48)} blocks resident`],
  ["NAV", (random) => `layout pass complete in ${12 + random.int(40)} ms`],
  ["GRID", (random) => `phosphor refresh ${random.pick([60, 72, 75])} Hz`],
  ["GRID", (random) => `fog line holding at ${400 + random.int(12) * 50} m`],
  ["UPLINK", (random) => `pass ${4_100 + random.int(26)} acquired, elevation ${12 + random.int(70)} deg`],
  ["UPLINK", (random) => `downlink ${3_000 + random.int(900)} frames, ${random.int(120)} dropped`],
  ["FENCE", () => "perimeter voltage nominal"],
  ["FENCE", (random) => `segment ${1 + random.int(12)} self-test passed`],
  ["KERNEL", (random) => `sync complete, ${8 + random.int(120)} buffers flushed`],
  ["MAIL", (random) => `${1 + random.int(3)} new message(s) for operator`],
  ["POWER", (random) => `generator B on standby, fuel ${55 + random.int(40)}%`],
];

/** The story, keyed by how many days before the last one each beat lands. */
const BEATS = new Map<number, Array<[string, string, string]>>([
  [26, [["03:12", "UPLINK", "archive link: first CRC error on channel 2"]]],
  [21, [["02:48", "UPLINK", "archive link DEGRADED (errors 0.4%)"]]],
  [17, [["01:57", "UPLINK", "unknown carrier near 1420.405 MHz, 11 s, not in catalogue"]]],
  [12, [["02:14", "UPLINK", "unknown carrier near 1420.405 MHz, 94 s"], ["02:15", "FENCE", "segment 7 voltage dip 3%, recovered"]]],
  [10, [["09:30", "OPS", "archive-001 recovered from tape, 4 reels, 1 sealed entry"]]],
  [9, [["10:02", "OPS", "budget review: media spend over plan again"]]],
  [7, [["02:14", "UPLINK", "carrier returned. modem answered it (S0=0). voice-memo.wav saved"]]],
  [4, [["02:14", "UPLINK", "unknown carrier near 1420.405 MHz, 212 s"], ["02:14", "KERNEL", "hit counter on personal-site decremented (?)"]]],
  [3, [["08:45", "OPS", "manual.pdf revision 0.1 filed in Downloads"]]],
  [1, [["02:14", "FENCE", "segment 7 offline 40 s"], ["02:15", "FENCE", "segment 7 restored, no operator action"]]],
  [0, [
    ["02:14", "KERNEL", "write to ~/Downloads/unknown.pkg by pid 0 (no such process)"],
    ["02:14", "UPLINK", "ARCHIVE LINK DEGRADED"],
    ["08:11", "NAV", "directory blocks now hold position when revisited"],
    ["08:12", "OPS", "field log written. do not trust unlabeled binaries"],
  ]],
]);

function timestamp(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function dailyLogs(): DailyLog[] {
  return Array.from({ length: DAYS }, (_, index) => {
    const daysBefore = DAYS - 1 - index;
    const date = new Date(LAST_DAY - daysBefore * DAY_MS).toISOString().slice(0, 10);
    const random = seeded(0x10c + index);
    const lines: Array<[string, string]> = [];

    let minute = random.int(40);
    const count = 18 + random.int(18);
    for (let line = 0; line < count && minute < 24 * 60; line += 1) {
      const [system, message] = random.pick(ROUTINE);
      lines.push([timestamp(minute), `${system.padEnd(6)} ${message(random)}`]);
      minute += 10 + random.int(80);
    }
    lines.push(["03:30", "KERNEL cron: nightly index rebuilt"]);
    for (const [time, system, message] of BEATS.get(daysBefore) ?? []) {
      lines.push([time, `${system.padEnd(6)} ${message}`]);
    }
    lines.sort((a, b) => a[0].localeCompare(b[0]));

    const header = `CONSOLE LOG / ${date} / HOST indigo2.lab / IRIX 6.2`;
    const content = [header, "=".repeat(header.length), ...lines.map(([time, text]) => `${date}T${time}  ${text}`), ""].join("\n");
    return { name: `console-${date}.log`, date, content, ageDays: daysBefore };
  });
}

/** One JSON object per uplink pass, the machine-readable twin of the console lines. */
export function uplinkJournal(): string {
  const random = seeded(0x5a7);
  const passes = Array.from({ length: 24 }, (_, index) => {
    const day = new Date(LAST_DAY - (23 - index) * DAY_MS).toISOString().slice(0, 10);
    const errors = Math.max(0, Math.round((index - 4) * 0.02 * 1000 + random.int(60)) / 1000);
    return JSON.stringify({
      pass: 4_100 + index,
      date: day,
      elevation: 12 + random.int(70),
      frames: 3_000 + random.int(900),
      errorRate: errors,
      link: errors > 0.3 ? "DEGRADED" : "NOMINAL",
    });
  });
  return `${passes.join("\n")}\n`;
}
