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
