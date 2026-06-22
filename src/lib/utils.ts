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

export function truncatePath(path: string, max = 54): string {
  return path.length > max ? "…" + path.slice(-(max - 1)) : path;
}
