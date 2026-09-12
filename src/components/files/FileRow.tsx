import type React from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { fileStatusStyle, splitPath } from "@/lib/fileStatus";

// Shared rows for every file list (commit detail, staging). One 24px row shape:
// status letter, filename, dim directory, and an optional right-hand slot.
// Rows follow the timeline's state language: 4% white on hover, 7% white plus
// a half-teal left edge when the row's file is the one open in the diff panel.

const INDENT_BASE = 10;
const INDENT_STEP = 14;

const ROW_BASE =
  "group relative flex h-6 items-center border-l-2 pr-2 text-xs transition-colors duration-75";

/**
 * The row's own clickable area — the element arrow-key navigation moves between.
 * scroll-mt keeps a focused row clear of a sticky list header above it.
 */
const ROW_BUTTON =
  "flex h-full min-w-0 flex-1 scroll-mt-9 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50";

interface FileRowProps {
  path: string;
  status: string | null;
  oldPath?: string | null;
  /** Tree view shows just the filename — the directory is the tree itself. */
  treeMode: boolean;
  depth?: number;
  /** This file is open in the diff panel. */
  selected?: boolean;
  onOpen?: () => void;
  /** Right-hand slot: a stage button, line counts, … */
  trailing?: React.ReactNode;
  /** Only show `trailing` while the row is hovered or focused (action buttons). */
  revealTrailing?: boolean;
  /** Extra words for the accessible name, e.g. "12 lines added, 3 removed". */
  detail?: string;
}

export function FileRow({
  path, status, oldPath, treeMode, depth = 0, selected = false, onOpen, trailing, revealTrailing, detail,
}: FileRowProps) {
  const { letter, color, label } = fileStatusStyle(status);
  const { dir, name } = splitPath(path);
  const oldName = oldPath ? splitPath(oldPath).name : null;
  const accessibleName = [name, label, dir && `in ${dir}`, oldPath && `from ${oldPath}`, detail]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className={cn(
        ROW_BASE,
        selected ? "border-l-teal-400/50 bg-white/[0.07]" : "border-l-transparent hover:bg-white/[0.04]",
      )}
      style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP - 2 }}
    >
      <button
        type="button"
        data-nav-row
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        aria-label={accessibleName}
        title={oldPath ? `${oldPath} → ${path}` : path}
        className={ROW_BUTTON}
      >
        <span aria-hidden className={cn("w-3 shrink-0 font-mono text-[11px] font-semibold", color)}>
          {letter}
        </span>
        <span aria-hidden className="min-w-0 flex-1 truncate">
          <span className={selected ? "text-foreground" : "text-foreground/90"}>{name}</span>
          {oldName && oldName !== name && (
            <span className="ml-1.5 text-[10px] text-muted-foreground">← {oldName}</span>
          )}
          {!treeMode && dir && <span className="ml-1.5 text-[10px] text-muted-foreground">{dir}</span>}
        </span>
      </button>
      {trailing && (
        <div
          className={cn(
            "ml-2 flex shrink-0 items-center",
            revealTrailing && "opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          {trailing}
        </div>
      )}
    </div>
  );
}

interface DirRowProps {
  name: string;
  expanded: boolean;
  onToggle: () => void;
  depth?: number;
  trailing?: React.ReactNode;
  revealTrailing?: boolean;
}

export function DirRow({ name, expanded, onToggle, depth = 0, trailing, revealTrailing }: DirRowProps) {
  const Icon = expanded ? FolderOpen : Folder;
  return (
    <div
      className={cn(ROW_BASE, "border-l-transparent hover:bg-white/[0.04]")}
      style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP - 2 }}
    >
      <button
        type="button"
        data-nav-row
        onClick={onToggle}
        onKeyDown={(e) => {
          // Tree convention: → opens a folder, ← closes it.
          if ((e.key === "ArrowRight" && !expanded) || (e.key === "ArrowLeft" && expanded)) {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
        aria-label={`${name} folder`}
        className={cn(ROW_BUTTON, "gap-1.5 select-none")}
      >
        <ChevronRight
          size={11}
          aria-hidden
          className={cn("shrink-0 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")}
        />
        <Icon size={12} aria-hidden className="shrink-0 text-muted-foreground/80" />
        <span className="min-w-0 truncate text-foreground/75">{name}</span>
      </button>
      {trailing && (
        <div
          className={cn(
            "ml-2 flex shrink-0 items-center",
            revealTrailing && "opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          {trailing}
        </div>
      )}
    </div>
  );
}

/**
 * ↑/↓ moves focus between the rows of a file list. Attach to the list's
 * container; rows are found by `data-nav-row`, so it works across sections
 * (staged + unstaged) and in virtualized lists (the neighbor is in overscan).
 */
export function handleFileListKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const target = e.target as HTMLElement;
  if (!target.matches("[data-nav-row]")) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-row]"));
  const next = rows[rows.indexOf(target) + (e.key === "ArrowDown" ? 1 : -1)];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}
