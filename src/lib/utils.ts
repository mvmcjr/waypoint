import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

const STASH_SUMMARY_RE = /^(WIP on |index on |untracked files on )/;

export function isStashCommit(oid: string, summary: string, stashOids: Set<string>) {
  return stashOids.has(oid) || STASH_SUMMARY_RE.test(summary);
}

/**
 * Strip git's auto-generated stash prefixes to reveal the user's name/message.
 * "WIP on main: a1b2c3d Subject" → "Subject"; "On main: my name" → "my name".
 */
export function stashLabel(message: string): string {
  return message
    .replace(/^WIP on [^:]+: [0-9a-f]+ /, "")
    .replace(/^On [^:]+: /, "")
    .trim();
}

export function repoLabel(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

/** The worktree folder's own name — the last path segment. Same logic as {@link repoLabel}. */
export function worktreeName(path: string): string {
  return repoLabel(path);
}

export function truncatePath(path: string, max = 54): string {
  return path.length > max ? "…" + path.slice(-(max - 1)) : path;
}

/**
 * Collapse the middle of a string so both ends stay visible:
 * "feature/very-long-name-SA-100" → "feature/v…SA-100". Useful for branch
 * names where the meaningful bits (prefix + ticket id) live at both ends.
 *
 * `tailWeight` (0–1) shifts how the kept characters split between head and
 * tail — omit it for the default even split. Pass something above 0.5 for
 * names whose distinguishing part lives near the end (e.g. an agent worktree
 * folder like "<repo>-agent-1" vs "-agent-2": with an even split a long
 * common prefix can push the differentiator into the omitted middle on both
 * names, making them render identically).
 */
export function truncateMiddle(s: string, max = 16, tailWeight?: number): string {
  if (s.length <= max) return s;
  const keep = max - 1; // one char spent on the ellipsis
  let head: number;
  let tail: number;
  if (tailWeight === undefined) {
    head = Math.ceil(keep / 2);
    tail = Math.floor(keep / 2);
  } else {
    tail = Math.max(1, Math.min(keep - 1, Math.round(keep * tailWeight)));
    head = keep - tail;
  }
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

/** The host OS's file manager name, for menu items like "Reveal in {explorerName()}". */
export function explorerName(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Mac OS X")) return "Finder";
  if (ua.includes("Linux")) return "Files";
  return "Explorer";
}
