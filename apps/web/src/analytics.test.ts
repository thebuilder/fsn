import { describe, expect, it } from "vitest";
import { stripFragment } from "./analytics";

describe("stripFragment", () => {
  it("strips the fragment from a url", () => {
    expect(stripFragment({ url: "https://example.com/path#/folder/file.txt" }).url).toBe(
      "https://example.com/path",
    );
  });

  it("leaves a url without a fragment unchanged", () => {
    expect(stripFragment({ url: "https://example.com/path" }).url).toBe("https://example.com/path");
  });

  it("removes everything after the first # when there are multiple", () => {
    expect(stripFragment({ url: "https://example.com/path#one#two" }).url).toBe(
      "https://example.com/path",
    );
  });

  it("preserves other event fields via the spread", () => {
    const event = { url: "https://example.com/#frag", type: "pageview", extra: 42 };

    expect(stripFragment(event)).toEqual({
      url: "https://example.com/",
      type: "pageview",
      extra: 42,
    });
  });
});
