import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CommitRow } from "./CommitRow";
import type { PositionedCommit } from "@/lib/ipc";

function commit(overrides: Partial<PositionedCommit["commit"]> = {}): PositionedCommit {
  return {
    lane: 0,
    row: 0,
    color_idx: 0,
    edges: [],
    commit: {
      oid: "1234567890abcdef1234567890abcdef12345678",
      parent_oids: [],
      summary: "fix login bug",
      body: "",
      author_name: "Ada Lovelace",
      author_email: "ada@example.com",
      timestamp: 1_700_000_000,
      refs: [],
      local_branches: [],
      remote_branches: [],
      ...overrides,
    },
  };
}

const BASE_PROPS = {
  refsWidth: 160,
  graphWidth: 40,
  isSelected: false,
  isHead: false,
  headBranch: null,
  onSelect: vi.fn(),
};

describe("CommitRow — dimming", () => {
  it("applies opacity-40 when isDimmed and not a stash row", () => {
    render(<CommitRow {...BASE_PROPS} item={commit()} isDimmed />);
    expect(screen.getByTestId("commit-row")).toHaveClass("opacity-40");
  });

  it("does not dim when isDimmed is false", () => {
    render(<CommitRow {...BASE_PROPS} item={commit()} isDimmed={false} />);
    expect(screen.getByTestId("commit-row")).not.toHaveClass("opacity-40");
  });

  it("keeps a dimmed (non-matching) stash row at opacity-35, not stacked with opacity-40", () => {
    render(<CommitRow {...BASE_PROPS} item={commit()} isStash isDimmed />);
    const row = screen.getByTestId("commit-row");
    expect(row).toHaveClass("opacity-35");
    expect(row).not.toHaveClass("opacity-40");
    expect(row).not.toHaveClass("opacity-60");
  });

  it("raises a matching stash row to opacity-60, distinguishing it from a non-match", () => {
    render(<CommitRow {...BASE_PROPS} item={commit()} isStash isDimmed={false} highlightTokens={["login"]} />);
    const row = screen.getByTestId("commit-row");
    expect(row).toHaveClass("opacity-60");
    expect(row).not.toHaveClass("opacity-35");
    expect(row).not.toHaveClass("opacity-40");
  });
});

describe("CommitRow — highlighting", () => {
  it("wraps matched tokens in <mark> within the summary", () => {
    render(<CommitRow {...BASE_PROPS} item={commit({ summary: "fix login bug" })} highlightTokens={["login"]} />);
    const mark = screen.getByText("login", { selector: "mark" });
    expect(mark).toBeInTheDocument();
  });

  it("wraps matched tokens in <mark> within the author name", () => {
    render(<CommitRow {...BASE_PROPS} item={commit({ author_name: "Grace Hopper" })} highlightTokens={["grace"]} />);
    expect(screen.getByText("Grace", { selector: "mark" })).toBeInTheDocument();
  });

  it("wraps a matched oid prefix in <mark> within the short hash", () => {
    render(<CommitRow {...BASE_PROPS} item={commit({ oid: "deadbeef00112233" })} highlightTokens={["dead"]} />);
    expect(screen.getByText("dead", { selector: "mark" })).toBeInTheDocument();
  });

  it("does not highlight the hash for a token that's too short or not an actual prefix", () => {
    // "de" is a real substring of the hash but only 2 chars — too short to ever
    // match by oid (see commitSearch's MIN_OID_TOKEN_LEN) — must not highlight.
    const { container: shortTokenContainer } = render(
      <CommitRow {...BASE_PROPS} item={commit({ oid: "deadbeef00112233" })} highlightTokens={["de"]} />,
    );
    expect(shortTokenContainer.querySelector("mark")).toBeNull();

    // "beef" is >=4 chars and does appear in the hash, but not as a *prefix* —
    // the oid doesn't start with it, so it must not highlight either.
    const { container: midHashContainer } = render(
      <CommitRow {...BASE_PROPS} item={commit({ oid: "deadbeef00112233" })} highlightTokens={["beef"]} />,
    );
    expect(midHashContainer.querySelector("mark")).toBeNull();
  });

  it("renders no <mark> elements when no tokens are given", () => {
    const { container } = render(<CommitRow {...BASE_PROPS} item={commit()} />);
    expect(container.querySelector("mark")).toBeNull();
  });
});
