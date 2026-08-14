// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { el } from "./dom";

describe("el", () => {
  it("creates an element with the given tag", () => {
    const div = el("div");

    expect(div.tagName).toBe("DIV");
  });

  it("applies the class name when given one", () => {
    const p = el("p", "eyebrow");

    expect(p.className).toBe("eyebrow");
  });

  it("leaves the class name empty when none is given", () => {
    const p = el("p");

    expect(p.className).toBe("");
  });

  it("sets text via textContent semantics, so markup stays literal text", () => {
    const heading = el("h3", undefined, "<b>bold</b>");

    expect(heading.textContent).toBe("<b>bold</b>");
    expect(heading.querySelector("b")).toBeNull();
    expect(heading.innerHTML).not.toContain("<b>bold</b>");
  });

  it("leaves text unset when none is given", () => {
    const span = el("span");

    expect(span.textContent).toBe("");
  });
});
