import { describe, it, expect } from "vitest";
import { reflowCommitBody } from "./commitMessage";

describe("reflowCommitBody", () => {
  it("joins a hard-wrapped paragraph into one line", () => {
    expect(reflowCommitBody("Three related failures when a repo is fresh, missing, or\ngains a remote while it is open.")).toBe(
      "Three related failures when a repo is fresh, missing, or gains a remote while it is open.",
    );
  });

  it("keeps blank lines between paragraphs", () => {
    expect(reflowCommitBody("First para\nwraps here.\n\nSecond para.")).toBe("First para wraps here.\n\nSecond para.");
  });

  it("keeps list items apart and joins their indented continuations", () => {
    const body = [
      "- Picking a folder without .git dead-ended on a raw error. open_repo now",
      "  distinguishes a missing folder from one that simply has no .git.",
      "- Second item.",
      "1. Numbered item",
      "   continues.",
    ].join("\n");
    expect(reflowCommitBody(body)).toBe(
      [
        "- Picking a folder without .git dead-ended on a raw error. open_repo now distinguishes a missing folder from one that simply has no .git.",
        "- Second item.",
        "1. Numbered item continues.",
      ].join("\n"),
    );
  });

  it("keeps trailers on their own lines", () => {
    expect(reflowCommitBody("Co-Authored-By: A <a@x>\nSigned-off-by: B <b@x>")).toBe(
      "Co-Authored-By: A <a@x>\nSigned-off-by: B <b@x>",
    );
  });

  it("keeps indented code blocks line by line", () => {
    expect(reflowCommitBody("Run:\n\n    pnpm fixtures\n    pnpm test")).toBe("Run:\n\n    pnpm fixtures\n    pnpm test");
  });

  it("normalizes CRLF and trims trailing blank lines", () => {
    expect(reflowCommitBody("One\r\ntwo\r\n\r\n")).toBe("One two");
  });
});
