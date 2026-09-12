import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileDiffPanel, type FileNav } from "./FileDiffPanel";
import { useStore } from "@/lib/store";
import type { FileDiff } from "@/lib/ipc";

const FILE: FileDiff = {
  path: "src/lib/ipc.ts",
  old_path: null,
  status: "modified",
  binary: false,
  hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [
    { kind: "context", content: "a" },
    { kind: "deletion", content: "b" },
    { kind: "addition", content: "B" },
  ] }],
};

function nav(overrides: Partial<FileNav> = {}): FileNav {
  return { index: 1, total: 3, onPrev: vi.fn(), onNext: vi.fn(), ...overrides };
}

describe("FileDiffPanel", () => {
  beforeEach(() => {
    useStore.setState({ diffLayout: "unified", diffScope: "hunks" });
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<FileDiffPanel file={FILE} commitSummary="s" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores keys typed into a field", () => {
    const onClose = vi.fn();
    render(<><input aria-label="field" /><FileDiffPanel file={FILE} commitSummary="s" onClose={onClose} /></>);
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("steps through files with [ ] and the header buttons, showing the position", () => {
    const n = nav();
    render(<FileDiffPanel file={FILE} commitSummary="s" onClose={vi.fn()} nav={n} />);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "]" });
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.click(screen.getByRole("button", { name: /next file/i }));
    expect(n.onNext).toHaveBeenCalledTimes(2);
    expect(n.onPrev).toHaveBeenCalledTimes(1);
  });

  it("disables stepping past either end", () => {
    const n = nav({ index: 2 });
    render(<FileDiffPanel file={FILE} commitSummary="s" onClose={vi.fn()} nav={n} />);
    expect(screen.getByRole("button", { name: /next file/i })).toBeDisabled();
    fireEvent.keyDown(window, { key: "]" });
    expect(n.onNext).not.toHaveBeenCalled();
  });

  it("remembers the split layout for the next file", () => {
    const { unmount } = render(<FileDiffPanel file={FILE} commitSummary="s" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    unmount();
    render(<FileDiffPanel file={{ ...FILE, path: "other.ts" }} commitSummary="s" onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
  });

  it("explains a binary file instead of showing an empty diff", () => {
    render(<FileDiffPanel file={{ ...FILE, binary: true, hunks: [] }} commitSummary="s" onClose={vi.fn()} />);
    expect(screen.getByText(/Binary file/)).toBeInTheDocument();
  });
});
