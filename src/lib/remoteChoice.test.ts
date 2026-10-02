import { describe, it, expect } from "vitest";
import { getDefaultRemote } from "./remoteChoice";

const origin = { name: "origin", url: "u1" };
const fork = { name: "fork", url: "u2" };
const other = { name: "zeta", url: "u3" };

describe("getDefaultRemote", () => {
  it("prefers origin", () => {
    expect(getDefaultRemote([other, origin])).toBe("origin");
  });

  it("falls back to the first remote when there is no origin", () => {
    expect(getDefaultRemote([other, fork])).toBe("zeta");
  });

  it("returns an empty string when there are no remotes", () => {
    expect(getDefaultRemote([])).toBe("");
  });
});
