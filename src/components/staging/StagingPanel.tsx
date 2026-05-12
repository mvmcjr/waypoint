import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  PlusCircle, MinusCircle, ChevronsUp, GitCommitHorizontal,
  ChevronRight, ChevronDown, Folder, FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc, type FileStatus } from "@/lib/ipc";
import { useFileStatus } from "@/lib/queries";

interface Props {
  repoId: string;
  onCommitSuccess: () => void;
}

// ── Tree data model ──────────────────────────────────────────────────────────

type FileNode = { kind: "file"; file: FileStatus };
type DirNode  = { kind: "dir";  name: string; path: string; children: TreeNode[] };
type TreeNode = FileNode | DirNode;

function buildTree(files: FileStatus[]): TreeNode[] {
  const dirMap = new Map<string, DirNode>();
  const roots: TreeNode[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  function getOrCreateDir(parts: string[], depth: number): DirNode {
    const path = parts.slice(0, depth).join("/");
    if (dirMap.has(path)) return dirMap.get(path)!;
    const node: DirNode = { kind: "dir", name: parts[depth - 1], path, children: [] };
    dirMap.set(path, node);
    if (depth === 1) {
      roots.push(node);
    } else {
      getOrCreateDir(parts, depth - 1).children.push(node);
    }
    return node;
  }

  for (const file of sorted) {
    const parts = file.path.split("/");
    if (parts.length === 1) {
      roots.push({ kind: "file", file });
    } else {
      getOrCreateDir(parts.slice(0, -1), parts.length - 1).children.push({ kind: "file", file });
    }
  }

  function sort(nodes: TreeNode[]): TreeNode[] {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      if (a.kind === "dir" && b.kind === "dir") return a.name.localeCompare(b.name);
      if (a.kind === "file" && b.kind === "file") return a.file.path.localeCompare(b.file.path);
      return 0;
    });
    for (const n of nodes) if (n.kind === "dir") sort(n.children);
    return nodes;
  }

  return sort(roots);
}

function collectPaths(node: TreeNode): string[] {
  if (node.kind === "file") return [node.file.path];
  return node.children.flatMap(collectPaths);
}

// ── Status styling ────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  added:     { label: "A", color: "text-green-400" },
  modified:  { label: "M", color: "text-yellow-400" },
  deleted:   { label: "D", color: "text-red-400" },
  renamed:   { label: "R", color: "text-blue-400" },
  untracked: { label: "?", color: "text-muted-foreground" },
};
const FALLBACK_STYLE = { label: "?", color: "text-muted-foreground" };

// ── FileRow ──────────────────────────────────────────────────────────────────

function FileRow({
  file, statusKind, actionIcon, onAction, disabled, indent = 0, treeMode,
}: {
  file: FileStatus;
  statusKind: string | null;
  actionIcon: React.ReactNode;
  onAction: () => void;
  disabled: boolean;
  indent?: number;
  treeMode: boolean;
}) {
  const { label, color } = STATUS_STYLE[statusKind ?? ""] ?? FALLBACK_STYLE;
  const parts = file.path.split("/");
  const filename = parts[parts.length - 1];
  const dir = !treeMode && parts.length > 1 ? parts.slice(0, -1).join("/") : "";

  return (
    <div
      className="group flex items-center gap-2 py-0.5 pr-3 hover:bg-white/5 rounded text-xs"
      style={{ paddingLeft: `${12 + indent * 16}px` }}
    >
      <span className={`font-mono font-bold w-3 shrink-0 ${color}`}>{label}</span>
      <span className="flex-1 min-w-0 truncate">
        {treeMode ? (
          <span className="text-foreground/90">{filename}</span>
        ) : (
          <>
            <span className="text-foreground/90">{filename}</span>
            {dir && <span className="text-muted-foreground ml-1.5 text-[10px]">{dir}</span>}
          </>
        )}
      </span>
      <button
        onClick={onAction}
        disabled={disabled}
        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity disabled:opacity-30"
      >
        {actionIcon}
      </button>
    </div>
  );
}

// ── DirRow ────────────────────────────────────────────────────────────────────

function DirRow({
  node, section, expanded, onToggle, onBatch, disabled, indent, children,
}: {
  node: DirNode;
  section: "staged" | "unstaged";
  expanded: boolean;
  onToggle: () => void;
  onBatch: (paths: string[]) => void;
  disabled: boolean;
  indent: number;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        className="group flex items-center gap-1.5 py-0.5 pr-3 hover:bg-white/5 rounded text-xs cursor-pointer select-none"
        style={{ paddingLeft: `${12 + indent * 16}px` }}
        onClick={onToggle}
      >
        {expanded
          ? <ChevronDown size={11} className="text-muted-foreground shrink-0" />
          : <ChevronRight size={11} className="text-muted-foreground shrink-0" />}
        {expanded
          ? <FolderOpen size={12} className="text-yellow-400/70 shrink-0" />
          : <Folder size={12} className="text-yellow-400/70 shrink-0" />}
        <span className="flex-1 text-foreground/75">{node.name}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onBatch(collectPaths(node)); }}
          disabled={disabled}
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity disabled:opacity-30"
          title={section === "staged" ? "Unstage folder" : "Stage folder"}
        >
          {section === "staged" ? <MinusCircle size={12} /> : <PlusCircle size={12} />}
        </button>
      </div>
      {expanded && children}
    </>
  );
}

// ── TreeNodes (recursive) ────────────────────────────────────────────────────

function TreeNodes({
  nodes, section, expandedDirs, toggleDir, onBatch, onSingleFile, disabled, indent = 0,
}: {
  nodes: TreeNode[];
  section: "staged" | "unstaged";
  expandedDirs: Set<string>;
  toggleDir: (p: string) => void;
  onBatch: (paths: string[]) => void;
  onSingleFile: (path: string) => void;
  disabled: boolean;
  indent?: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "file") {
          const statusKind = section === "staged" ? node.file.staged : node.file.unstaged;
          return (
            <FileRow
              key={node.file.path + "-" + section}
              file={node.file}
              statusKind={statusKind}
              actionIcon={section === "staged" ? <MinusCircle size={13} /> : <PlusCircle size={13} />}
              onAction={() => onSingleFile(node.file.path)}
              disabled={disabled}
              indent={indent}
              treeMode
            />
          );
        }
        const isExpanded = expandedDirs.has(node.path);
        return (
          <DirRow
            key={node.path + "-" + section}
            node={node}
            section={section}
            expanded={isExpanded}
            onToggle={() => toggleDir(node.path)}
            onBatch={onBatch}
            disabled={disabled}
            indent={indent}
          >
            <TreeNodes
              nodes={node.children}
              section={section}
              expandedDirs={expandedDirs}
              toggleDir={toggleDir}
              onBatch={onBatch}
              onSingleFile={onSingleFile}
              disabled={disabled}
              indent={indent + 1}
            />
          </DirRow>
        );
      })}
    </>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function StagingPanel({ repoId, onCommitSuccess }: Props) {
  const qc = useQueryClient();
  const { data: files = [], isLoading } = useFileStatus(repoId);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [committing, setCommitting] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"path" | "tree">("path");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const staged   = files.filter((f) => f.staged !== null);
  const unstaged = files.filter((f) => f.unstaged !== null);
  const stagedTree   = useMemo(() => buildTree(staged),   [staged]);
  const unstagedTree = useMemo(() => buildTree(unstaged), [unstaged]);

  const disabled = committing || working;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["staging", repoId] });
    qc.invalidateQueries({ queryKey: ["status", repoId] });
  }

  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  async function stageFile(path: string)   { await ipc.stageFile(repoId, path);   invalidate(); }
  async function unstageFile(path: string) { await ipc.unstageFile(repoId, path); invalidate(); }

  async function stagePaths(paths: string[]) {
    setWorking(true);
    try { await ipc.stagePaths(repoId, paths); invalidate(); } finally { setWorking(false); }
  }
  async function unstagePaths(paths: string[]) {
    setWorking(true);
    try { await ipc.unstagePaths(repoId, paths); invalidate(); } finally { setWorking(false); }
  }

  async function handleStageAll() { await ipc.stageAll(repoId); invalidate(); }

  async function handleCommit() {
    const msg = summary.trim();
    if (!msg || staged.length === 0) return;
    const full = description.trim() ? `${msg}\n\n${description.trim()}` : msg;
    setCommitting(true);
    setError(null);
    try {
      await ipc.doCommit(repoId, full);
      setSummary("");
      setDescription("");
      onCommitSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  const canCommit = staged.length > 0 && summary.trim().length > 0 && !committing;

  return (
    <div className="flex flex-col h-full border-l border-border text-sm overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <span className="font-semibold text-foreground/80 text-xs uppercase tracking-wide shrink-0">
          Changes
        </span>

        {/* View toggle */}
        <div className="flex items-center gap-0.5 bg-white/5 rounded p-0.5">
          {(["path", "tree"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={[
                "text-[10px] capitalize px-1.5 py-0.5 rounded transition-colors",
                view === v ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {v}
            </button>
          ))}
        </div>

        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs gap-1 shrink-0"
          onClick={handleStageAll}
          disabled={unstaged.length === 0 || disabled}
        >
          <ChevronsUp size={12} />
          Stage All
        </Button>
      </div>

      {/* File lists */}
      <div className="flex-1 overflow-y-auto min-h-0 py-1">
        {isLoading && (
          <p className="text-xs text-muted-foreground px-3 py-2">Loading…</p>
        )}

        {staged.length > 0 && (
          <section>
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Staged ({staged.length})
            </div>
            {view === "path" ? staged.map((f) => (
              <FileRow
                key={f.path + "-staged"}
                file={f} statusKind={f.staged}
                actionIcon={<MinusCircle size={13} />}
                onAction={() => unstageFile(f.path)}
                disabled={disabled} treeMode={false}
              />
            )) : (
              <TreeNodes
                nodes={stagedTree} section="staged"
                expandedDirs={expandedDirs} toggleDir={toggleDir}
                onBatch={unstagePaths} onSingleFile={unstageFile}
                disabled={disabled}
              />
            )}
          </section>
        )}

        {unstaged.length > 0 && (
          <section className={staged.length > 0 ? "mt-2" : ""}>
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Unstaged ({unstaged.length})
            </div>
            {view === "path" ? unstaged.map((f) => (
              <FileRow
                key={f.path + "-unstaged"}
                file={f} statusKind={f.unstaged}
                actionIcon={<PlusCircle size={13} />}
                onAction={() => stageFile(f.path)}
                disabled={disabled} treeMode={false}
              />
            )) : (
              <TreeNodes
                nodes={unstagedTree} section="unstaged"
                expandedDirs={expandedDirs} toggleDir={toggleDir}
                onBatch={stagePaths} onSingleFile={stageFile}
                disabled={disabled}
              />
            )}
          </section>
        )}

        {!isLoading && staged.length === 0 && unstaged.length === 0 && (
          <p className="text-xs text-muted-foreground px-3 py-4 text-center">
            Working tree is clean.
          </p>
        )}
      </div>

      {/* Commit area */}
      <div className="shrink-0 border-t border-border p-3 flex flex-col gap-2">
        <input
          type="text"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleCommit(); }}
          placeholder="Summary (required)"
          maxLength={72}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleCommit(); }}
          placeholder="Description (optional)…"
          rows={2}
          className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          size="sm"
          className="w-full gap-1.5"
          onClick={handleCommit}
          disabled={!canCommit}
        >
          <GitCommitHorizontal size={13} />
          Commit{staged.length > 0 ? ` ${staged.length} file${staged.length !== 1 ? "s" : ""}` : ""}
        </Button>
      </div>
    </div>
  );
}
