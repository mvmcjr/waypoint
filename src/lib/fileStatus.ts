// Shared presentation of a file's change status — the single source for the
// status letter + color used by the commit file list, the staging lists, and
// the diff panel header, so the same change reads the same everywhere.
import type { FileDiff } from "./ipc";

export type FileChangeKind =
  | "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "other";

interface StatusStyle {
  letter: string;
  /** Text color class for the status letter. */
  color: string;
  /** Spoken label for screen readers. */
  label: string;
}

const STATUS: Record<FileChangeKind, StatusStyle> = {
  added:     { letter: "A", color: "text-green-400",        label: "added" },
  modified:  { letter: "M", color: "text-yellow-400",       label: "modified" },
  deleted:   { letter: "D", color: "text-red-400",          label: "deleted" },
  renamed:   { letter: "R", color: "text-blue-400",         label: "renamed" },
  copied:    { letter: "C", color: "text-blue-400",         label: "copied" },
  // Untracked = a new file, just not staged yet — show it like an add ("A")
  // rather than a cryptic "?". The status key stays "untracked" for stage/discard logic.
  untracked: { letter: "A", color: "text-green-400",        label: "new, untracked" },
  other:     { letter: "?", color: "text-muted-foreground", label: "changed" },
};

export function fileStatusStyle(kind: string | null | undefined): StatusStyle {
  return STATUS[kind as FileChangeKind] ?? STATUS.other;
}

/** Split "a/b/c.ts" into { dir: "a/b", name: "c.ts" }. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i === -1 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

export interface LineStats {
  added: number;
  removed: number;
}

/** Added/removed line counts for one file, derived from its already-loaded hunks. */
export function fileLineStats(file: FileDiff): LineStats {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "addition") added++;
      else if (line.kind === "deletion") removed++;
    }
  }
  return { added, removed };
}
