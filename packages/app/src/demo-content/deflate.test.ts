import { describe, expect, it } from "vitest";
import { seeded, utf8 } from "./bytes";
import { deflateRaw, deflateZlib } from "./deflate";
import { inflate } from "./testing";

describe("deflate", () => {
  const random = seeded(7);
  const noise = Uint8Array.from({ length: 70_000 }, () => random.int(256));
  const samples: Array<[string, Uint8Array]> = [
    ["empty input", new Uint8Array()],
    ["a single byte", new Uint8Array([65])],
    ["prose", utf8("The horizon must never quite arrive. ".repeat(40))],
    ["a long run of one byte", new Uint8Array(100_000).fill(0x2a)],
    ["incompressible noise past the 32 KB window", noise],
  ];

  it.each(samples)("round-trips %s through a standard inflater", async (_, input) => {
    expect(await inflate(deflateRaw(input), "deflate-raw")).toEqual(input);
  });

  it("wraps the stream in a zlib header and Adler-32 trailer that inflaters accept", async () => {
    const input = utf8("phosphor ".repeat(500));

    expect(await inflate(deflateZlib(input), "deflate")).toEqual(input);
  });

  it("actually compresses repetitive text", () => {
    const input = utf8("BLOCK OK\n".repeat(1_000));

    expect(deflateRaw(input).length).toBeLessThan(input.length / 20);
  });
});
