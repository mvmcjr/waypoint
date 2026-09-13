import { describe, it, expect } from "vitest";
import { worktreeStatusInterval } from "./queries";

describe("worktreeStatusInterval", () => {
  it("backs off to 5x the last scan, never below 3s", () => {
    expect(worktreeStatusInterval(0)).toBe(3000);
    expect(worktreeStatusInterval(400)).toBe(3000);
    expect(worktreeStatusInterval(1200)).toBe(6000);
  });
});
