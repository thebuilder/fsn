import { archiveZip, buildOutputZip } from "./archives";
import { ambientLoop, modemHandshake } from "./audio";
import {
  classifiedData,
  guestbookDatabase,
  pefApplication,
  resourceFile,
  telemetryFrames,
  unknownPackage,
} from "./binaries";
import { operatorsManual } from "./manual";
import { contactSheet } from "./png";

/**
 * Every binary object in the demo filesystem, by the name `demo.ts` refers to it.
 *
 * This module is only ever loaded with a dynamic import, the first time one of these
 * files is opened, so the encoders behind it stay out of the bundle a visitor
 * downloads just to look at the city.
 */
export const generators = {
  buildOutput: buildOutputZip,
  archive: archiveZip,
  manual: operatorsManual,
  contactSheet,
  modemHandshake,
  ambientLoop,
  classified: classifiedData,
  telemetry: telemetryFrames,
  unknownPackage,
  guestbook: guestbookDatabase,
  hyperCard: () => pefApplication("HyperCard", [
    "Where is the Home stack?",
    "Please locate Home.",
    "on mouseUp\r  go to card \"Navigator\"\rend mouseUp",
    "The user level is set to 5: Scripting.",
  ], 0x4c01),
  macPaint: () => pefApplication("MacPaint", [
    "FatBits",
    "Not enough memory to paste the picture.",
    "Lasso",
    "The paint bucket is leaking.",
  ], 0x4c02),
  netscape: () => pefApplication("Netscape Navigator", [
    "Mozilla/3.01 (Macintosh; I; PPC)",
    "Netscape is unable to locate the server.",
    "about:mozilla",
    "The Book of Mozilla, 12:10",
  ], 0x4c03),
  simpleText: () => pefApplication("SimpleText", [
    "32K text limit reached.",
    "This document cannot be opened because SimpleText cannot open documents of this type.",
    "Speak All",
  ], 0x4c04),
  systemProfiler: () => pefApplication("System Profiler", [
    "Machine: Power Macintosh 8500/120",
    "Built-in memory: 64 MB",
    "Modem: US Robotics Sportster 28.8 (auto-answer OFF)",
    "Unidentified device on SCSI ID 7",
  ], 0x4c05),
  appleScript: () => resourceFile(["STR#", "scpt", "vers"], [
    "tell application \"Finder\" to open folder \"Downloads\"",
    "AppleScript 1.1",
    "Can't get item 1 of folder \"west platform\".",
  ], 0x5e01),
  quickTime: () => resourceFile(["STR#", "thng", "vers"], [
    "QuickTime 2.5",
    "Moov",
    "Couldn't open the movie because it is not a movie.",
  ], 0x5e02),
  soundManager: () => resourceFile(["snd ", "STR#", "vers"], [
    "Sosumi",
    "Wild Eep",
    "Indigo",
    "Sound Manager 3.2",
  ], 0x5e03),
  system: () => resourceFile(["boot", "STR#", "ICN#", "vers"], [
    "Welcome to Macintosh.",
    "Sorry, a system error occurred.",
    "The Finder cannot be found.",
    "System Software 7.5.3",
    "Hidden in the resources: made by the Blue Meanies.",
  ], 0x5e04),
  finder: () => pefApplication("Finder", [
    "The Trash cannot be emptied because a file is locked.",
    "The disk \"Macintosh HD\" needs minor repairs.",
    "Clean Up Window",
    "About This Macintosh...",
  ], 0x5e05),
  geneva: () => resourceFile(["FOND", "NFNT", "vers"], [
    "Geneva",
    "Geneva 9",
    "Geneva 12",
    "The quick brown fox jumps over the lazy dog.",
  ], 0x5e06),
  finderPreferences: () => resourceFile(["pref", "STR#"], [
    "View by Icon",
    "Always snap to grid",
    "Show disk info in header",
  ], 0x5e07),
} satisfies Record<string, () => Uint8Array<ArrayBuffer>>;

export type GeneratorId = keyof typeof generators;
