import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GoToCommit } from "./GoToCommit";
import type { PositionedCommit } from "@/lib/ipc";

function commit(oid: string, summary: string, overrides: Partial<PositionedCommit["commit"]> = {}): PositionedCommit {
  return {
    lane: 0,
    row: 0,
    color_idx: 0,
    edges: [],
    commit: {
      oid,
      parent_oids: [],
      summary,
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

// Timeline order: newest (index 0) → oldest. "login" matches indices 0 and 2.
const COMMITS: PositionedCommit[] = [
  commit("1111111111", "fix login bug"),
  commit("2222222222", "unrelated change"),
  commit("3333333333", "fix login redirect"),
  commit("4444444444", "another unrelated change"),
];

function typeQuery(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  act(() => {
    vi.advanceTimersByTime(120);
  });
}

function setup(props: Partial<React.ComponentProps<typeof GoToCommit>> = {}) {
  const onGo = vi.fn();
  const onMatchesChange = vi.fn();
  const utils = render(
    <GoToCommit commits={COMMITS} selectedOid={null} onGo={onGo} onMatchesChange={onMatchesChange} {...props} />,
  );
  const input = screen.getByRole("searchbox");
  return { ...utils, input, onGo, onMatchesChange };
}

describe("GoToCommit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces the query and reports matches only after it settles", () => {
    const { input, onMatchesChange } = setup();
    fireEvent.change(input, { target: { value: "login" } });
    // Not settled yet — only the initial (empty-query) report should have fired.
    expect(onMatchesChange).toHaveBeenLastCalledWith({ matchOids: null, tokens: [] });

    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(onMatchesChange).toHaveBeenLastCalledWith({
      matchOids: new Set(["1111111111", "3333333333"]),
      tokens: ["login"],
    });
  });

  it("flushes a pending debounce before navigating, so Enter right after typing doesn't use stale matches", () => {
    const hashCommit = commit("abcd123456", "unrelated for hash test");
    const onGo = vi.fn();
    render(
      <GoToCommit commits={[...COMMITS, hashCommit]} selectedOid={null} onGo={onGo} onMatchesChange={vi.fn()} />,
    );
    const input = screen.getByRole("searchbox");

    fireEvent.change(input, { target: { value: "abcd1234" } });
    // No timer advance — debouncedQuery is still "" when Enter fires.
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onGo).toHaveBeenCalledWith("abcd123456");
  });

  it("shows 'No matches' when nothing matches", () => {
    const { input } = setup();
    typeQuery(input, "zzz-nope");
    expect(screen.getByTestId("match-counter")).toHaveTextContent("No matches");
  });

  it("shows '{n} matches' when the selected commit isn't one of them", () => {
    const { input } = setup({ selectedOid: "2222222222" });
    typeQuery(input, "login");
    expect(screen.getByTestId("match-counter")).toHaveTextContent("2 matches");
  });

  it("shows '{i} / {n}' when the selected commit is a match", () => {
    const { input } = setup({ selectedOid: "3333333333" });
    typeQuery(input, "login");
    expect(screen.getByTestId("match-counter")).toHaveTextContent("2 / 2");
  });

  it("hides the counter entirely while there are no commits, even with a query", () => {
    const { input } = setup({ commits: [] });
    typeQuery(input, "login");
    expect(screen.queryByTestId("match-counter")).not.toBeInTheDocument();
    expect(screen.queryByText(/match/i)).not.toBeInTheDocument();
  });

  it("Enter goes to the first match when nothing is selected, then to the next match, wrapping at the end", () => {
    const onGo = vi.fn();
    const { input, rerender } = setup({ onGo });
    typeQuery(input, "login");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGo).toHaveBeenLastCalledWith("1111111111");

    rerender(<GoToCommit commits={COMMITS} selectedOid="1111111111" onGo={onGo} onMatchesChange={vi.fn()} />);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGo).toHaveBeenLastCalledWith("3333333333");

    // Wraps back to the first match past the last one.
    rerender(<GoToCommit commits={COMMITS} selectedOid="3333333333" onGo={onGo} onMatchesChange={vi.fn()} />);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGo).toHaveBeenLastCalledWith("1111111111");
  });

  it("Shift+Enter goes to the previous match, wrapping to the last at the start", () => {
    const onGo = vi.fn();
    const { input, rerender } = setup({ onGo, selectedOid: "1111111111" });
    typeQuery(input, "login");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onGo).toHaveBeenLastCalledWith("3333333333");

    rerender(<GoToCommit commits={COMMITS} selectedOid="3333333333" onGo={onGo} onMatchesChange={vi.fn()} />);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onGo).toHaveBeenLastCalledWith("1111111111");
  });

  it("Ctrl+G navigates matches globally, even when focus is elsewhere in the app", () => {
    const onGo = vi.fn();
    const { input } = setup({ onGo });
    typeQuery(input, "login");
    input.blur();

    fireEvent.keyDown(window, { key: "g", ctrlKey: true });
    expect(onGo).toHaveBeenCalledWith("1111111111");
  });

  it("Ctrl+G is ignored while typing in another text field", () => {
    const onGo = vi.fn();
    render(
      <div>
        <textarea data-testid="other-field" />
        <GoToCommit commits={COMMITS} selectedOid={null} onGo={onGo} onMatchesChange={vi.fn()} />
      </div>,
    );
    const input = screen.getByRole("searchbox");
    typeQuery(input, "login");
    input.blur();

    const other = screen.getByTestId("other-field");
    other.focus();
    fireEvent.keyDown(window, { key: "g", ctrlKey: true });
    expect(onGo).not.toHaveBeenCalled();
  });

  it("Ctrl+F focuses and selects the field", () => {
    const { input } = setup();
    (input as HTMLInputElement).blur();
    expect(input).not.toHaveFocus();

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(input).toHaveFocus();
  });

  it("Escape clears a non-empty query and restores focus to what had it before Ctrl+F", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    const { input } = setup();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true }); // remembers `button`, focuses the field
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "login" } });
    expect(input).toHaveValue("login");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(button).toHaveFocus();

    document.body.removeChild(button);
  });
});
