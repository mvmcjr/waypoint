import { describe, it, expect } from "vitest";
import { getDefaultRemote, remotesToFetch } from "./remoteChoice";

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

describe("remotesToFetch", () => {
  const targets = (remote: string) => ({
    pull: { remote, branch: "main" },
    push: { remote, branch: "main", set_upstream: false },
  });

  it("fetches the default remote and a different upstream remote", () => {
    expect(remotesToFetch("origin", targets("fork"))).toEqual(["origin", "fork"]);
  });

  it("fetches once when the upstream remote is the default", () => {
    expect(remotesToFetch("origin", targets("origin"))).toEqual(["origin"]);
  });

  it("also fetches a distinct push remote, once", () => {
    const t = { pull: { remote: "origin", branch: "main" }, push: { remote: "fork", branch: "main", set_upstream: false } };
    expect(remotesToFetch("origin", t)).toEqual(["origin", "fork"]);
    const t2 = { pull: { remote: "up", branch: "main" }, push: { remote: "fork", branch: "main", set_upstream: false } };
    expect(remotesToFetch("origin", t2)).toEqual(["origin", "up", "fork"]);
    const t3 = { pull: { remote: "fork", branch: "main" }, push: { remote: "fork", branch: "main", set_upstream: false } };
    expect(remotesToFetch("origin", t3)).toEqual(["origin", "fork"]);
  });

  it("fetches just the default remote without targets", () => {
    expect(remotesToFetch("origin", null)).toEqual(["origin"]);
    expect(remotesToFetch("origin", { pull: null, push: null })).toEqual(["origin"]);
  });
});
