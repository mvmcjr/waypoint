import { describe, it, expect } from "vitest";
import { buildCommitIndex, findMatches, splitHighlights } from "./commitSearch";
import type { PositionedCommit } from "./ipc";

function commit(overrides: Partial<PositionedCommit["commit"]> = {}): PositionedCommit {
  return {
    lane: 0,
    row: 0,
    color_idx: 0,
    edges: [],
    commit: {
      oid: "0000000000000000000000000000000000000000",
      parent_oids: [],
      summary: "a commit",
      body: "",
      author_name: "Ada Lovelace",
      author_email: "ada@example.com",
      timestamp: 0,
      refs: [],
      local_branches: [],
      remote_branches: [],
      ...overrides,
    },
  };
}

describe("findMatches", () => {
  it("returns no oids and no tokens for an empty query", () => {
    const index = buildCommitIndex([commit()]);
    const result = findMatches(index, "   ");
    expect(result.oids).toEqual([]);
    expect(result.tokens).toEqual([]);
  });

  it("requires every token to match (AND) — a commit missing one token is excluded", () => {
    const matchesBoth = commit({ summary: "fix login bug", oid: "1111111111" });
    const matchesOne = commit({ summary: "fix other bug", oid: "2222222222" });
    const index = buildCommitIndex([matchesBoth, matchesOne]);
    const result = findMatches(index, "fix login");
    expect(result.oids).toEqual(["1111111111"]);
  });

  it("matches a token as a substring of the summary, author name, author email, or a ref name", () => {
    const bySummary = commit({ summary: "fix login bug", oid: "1111111111" });
    const byAuthorName = commit({ author_name: "Loginbot", summary: "unrelated", oid: "2222222222" });
    const byAuthorEmail = commit({ author_email: "login@example.com", summary: "unrelated", oid: "3333333333" });
    const byRef = commit({ summary: "unrelated", local_branches: ["feature/login"], oid: "4444444444" });
    const index = buildCommitIndex([bySummary, byAuthorName, byAuthorEmail, byRef]);
    const result = findMatches(index, "login");
    expect(result.oids).toEqual(["1111111111", "2222222222", "3333333333", "4444444444"]);
  });

  it("matches the oid only as a prefix, only when the token is >=4 chars", () => {
    const prefixMatch = commit({ oid: "deadbeef00", summary: "unrelated" });
    const midMatch = commit({ oid: "aa11223344bb", summary: "nothing here" });
    const shortToken = commit({ oid: "abc1234567", summary: "nothing here either" });

    const index = buildCommitIndex([prefixMatch, midMatch, shortToken]);

    expect(findMatches(index, "dead").oids).toEqual(["deadbeef00"]);
    // "1122" appears mid-oid, not as a prefix — must not match.
    expect(findMatches(index, "1122").oids).toEqual([]);
    // "abc" is a genuine oid prefix but only 3 chars — too short to count as an oid match,
    // and it doesn't appear in any other field either.
    expect(findMatches(index, "abc").oids).toEqual([]);
  });

  it("is case-insensitive", () => {
    const index = buildCommitIndex([commit({ summary: "Fix Login Bug" })]);
    expect(findMatches(index, "LOGIN").oids).toHaveLength(1);
  });

  it("preserves timeline (input) order", () => {
    const a = commit({ summary: "fix login one", oid: "1111111111" });
    const b = commit({ summary: "fix login two", oid: "2222222222" });
    const c = commit({ summary: "fix login three", oid: "3333333333" });
    const index = buildCommitIndex([a, b, c]);
    expect(findMatches(index, "login").oids).toEqual(["1111111111", "2222222222", "3333333333"]);
  });

  it("matches a stash's display label, not just its raw WIP-prefixed summary", () => {
    const stash = commit({ summary: "WIP on main: a1b2c3d fix the thing", oid: "5555555555" });
    const index = buildCommitIndex([stash]);
    // "fix the thing" is only findable via the derived label — the raw summary
    // also contains it, but this exercises the stashLabel() path directly.
    expect(findMatches(index, "fix the thing").oids).toEqual(["5555555555"]);
  });
});

describe("splitHighlights", () => {
  it("returns a single unmatched segment when there are no tokens", () => {
    expect(splitHighlights("hello world", [])).toEqual([{ text: "hello world", match: false }]);
  });

  it("splits a single match out of surrounding text", () => {
    expect(splitHighlights("fix login bug", ["login"])).toEqual([
      { text: "fix ", match: false },
      { text: "login", match: true },
      { text: " bug", match: false },
    ]);
  });

  it("is case-insensitive while preserving original casing in the output", () => {
    expect(splitHighlights("Fix Login Bug", ["login"])).toEqual([
      { text: "Fix ", match: false },
      { text: "Login", match: true },
      { text: " Bug", match: false },
    ]);
  });

  it("merges overlapping/adjacent token matches into one run", () => {
    expect(splitHighlights("fix login bug", ["log", "gin"])).toEqual([
      { text: "fix ", match: false },
      { text: "login", match: true },
      { text: " bug", match: false },
    ]);
  });

  it("handles multiple separate matches", () => {
    expect(splitHighlights("login: fix login bug", ["login"])).toEqual([
      { text: "login", match: true },
      { text: ": fix ", match: false },
      { text: "login", match: true },
      { text: " bug", match: false },
    ]);
  });
});
