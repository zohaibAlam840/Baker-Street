import { describe, expect, it } from "vitest";

import { safeAuthNext } from "./redirects";

describe("authentication return paths", () => {
  it("accepts same-origin relative paths", () => {
    expect(safeAuthNext("/reset-password?source=email")).toBe("/reset-password?source=email");
  });

  it("rejects protocol-relative and backslash redirects", () => {
    expect(safeAuthNext("//evil.example/login")).toBe("/dashboard");
    expect(safeAuthNext("/\\evil.example/login")).toBe("/dashboard");
    expect(safeAuthNext("https://evil.example/login")).toBe("/dashboard");
  });
});
