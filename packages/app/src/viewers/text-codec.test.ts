import { describe, expect, it } from "vitest";
import { decodeTextDocument, isStrictUtf8, serializeTextDocument } from "./text-codec";

const encoder = new TextEncoder();

function encoded(value: string, bom = false): Uint8Array {
  const bytes = encoder.encode(value);
  return bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]) : bytes;
}

describe("text document codec", () => {
  it("detects and removes a UTF-8 BOM for the editor, then restores it", () => {
    const document = decodeTextDocument(encoded("first\nsecond", true));

    expect(document.value).toBe("first\nsecond");
    expect(document.hadUtf8Bom).toBe(true);
    expect(serializeTextDocument(document.value, document)).toBe("\uFEFFfirst\nsecond");
  });

  it("normalizes CRLF for the editor and restores it on write", () => {
    const document = decodeTextDocument(encoded("first\r\nsecond\r\n"));

    expect(document.value).toBe("first\nsecond\n");
    expect(document.lineSeparators).toEqual(["\r\n", "\r\n"]);
    expect(serializeTextDocument(document.value, document)).toBe("first\r\nsecond\r\n");
  });

  it("round-trips mixed CRLF, LF, and CR separators unchanged", () => {
    const original = "one\r\ntwo\nthree\rfour\r\n";
    const document = decodeTextDocument(encoded(original));

    expect(document.value).toBe("one\ntwo\nthree\nfour\n");
    expect(document.lineSeparators).toEqual(["\r\n", "\n", "\r", "\r\n"]);
    expect(serializeTextDocument(document.value, document)).toBe(original);
  });

  it("keeps separators positionally while using the dominant separator for new lines", () => {
    const document = decodeTextDocument(encoded("one\r\ntwo\r\nthree\n"));

    expect(serializeTextDocument("ONE\ntwo\nthree\nfour\nfive", document)).toBe(
      "ONE\r\ntwo\r\nthree\nfour\r\nfive",
    );
  });

  it("uses the first source separator when separator counts tie", () => {
    const document = decodeTextDocument(encoded("one\r\ntwo\nthree"));

    expect(serializeTextDocument("one\ntwo\nthree\nfour", document)).toBe("one\r\ntwo\nthree\r\nfour");
  });

  it("rejects invalid UTF-8 instead of replacing malformed bytes", () => {
    expect(() => decodeTextDocument(new Uint8Array([0xc3, 0x28]))).toThrow("not valid UTF-8 text");
  });
});

describe("isStrictUtf8", () => {
  it("accepts plain ASCII", () => {
    expect(isStrictUtf8(encoded("hello world"))).toBe(true);
  });

  it("accepts UTF-8 with a BOM", () => {
    expect(isStrictUtf8(encoded("first\nsecond", true))).toBe(true);
  });

  it("accepts multi-byte emoji", () => {
    expect(isStrictUtf8(encoded("sparkles ✨ rocket 🚀"))).toBe(true);
  });

  it("rejects bytes that are not valid UTF-8 text", () => {
    expect(isStrictUtf8(new Uint8Array([0xff, 0xfe]))).toBe(false);
  });

  it("rejects a lone continuation byte", () => {
    expect(isStrictUtf8(new Uint8Array([0x80]))).toBe(false);
  });

  it("rejects a truncated multi-byte sequence", () => {
    expect(isStrictUtf8(new Uint8Array([0xe2, 0x82]))).toBe(false);
  });
});
