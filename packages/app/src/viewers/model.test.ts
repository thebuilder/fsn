import { describe, expect, it } from "vitest";
import { confineLoaderUrl } from "./model";

describe("confineLoaderUrl", () => {
  it("passes through self-contained references", () => {
    expect(confineLoaderUrl("data:application/octet-stream;base64,AAA")).toBe(
      "data:application/octet-stream;base64,AAA",
    );
    expect(confineLoaderUrl("blob:https://example/xyz")).toBe("blob:https://example/xyz");
  });

  it("collapses anything that would leave the page to an empty data URI", () => {
    expect(confineLoaderUrl("https://evil.example/x.bin")).toBe("data:,");
    expect(confineLoaderUrl("http://evil.example/x.bin")).toBe("data:,");
    expect(confineLoaderUrl("//evil.example/x.bin")).toBe("data:,");
    expect(confineLoaderUrl("textures/wood.png")).toBe("data:,");
    expect(confineLoaderUrl("/absolute/path.png")).toBe("data:,");
    expect(confineLoaderUrl("file:///etc/hosts")).toBe("data:,");
  });
});
