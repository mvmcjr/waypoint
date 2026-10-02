import { describe, it, expect } from "vitest";
import { chooseRemote } from "./remoteChoice";

const origin = { name: "origin", url: "u1" };
const fork = { name: "fork", url: "u2" };
const other = { name: "zeta", url: "u3" };

describe("chooseRemote", () => {
  it("returns the upstream remote when present", () => {
    expect(chooseRemote([origin, fork], { remote: "fork", branch: "main" })).toBe("fork");
  });

  it("falls back to origin without an upstream", () => {
    expect(chooseRemote([other, origin], null)).toBe("origin");
  });

  it("falls back to the first remote when there is no origin", () => {
    expect(chooseRemote([other, fork], undefined)).toBe("zeta");
  });

  it("ignores an upstream remote that no longer exists", () => {
    expect(chooseRemote([origin], { remote: "gone", branch: "main" })).toBe("origin");
  });

  it("returns an empty string when there are no remotes", () => {
    expect(chooseRemote([], null)).toBe("");
    expect(chooseRemote([], { remote: "fork", branch: "main" })).toBe("");
  });
});
