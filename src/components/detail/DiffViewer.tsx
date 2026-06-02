import type { FileDiff } from "@/lib/ipc";
import { DIFF_STATUS_COLOR } from "@/lib/ipc";
import { useState, useEffect, useMemo } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { buildFileTree, collectDirPaths, type TreeNode, type DirNode } from "@/lib/fileTree";

interface Props {
  files: FileDiff[];
  onFileClick?: (file: FileDiff) => void;
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<FileDiff["status"], string> = {
  added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C", other: "?",
};

// ── Hunk display ─────────────────────────────────────────────────────────────

function HunkView({ hunk }: { hunk: FileDiff["hunks"][number] }) {
  return (
    <div className="text-xs font-mono">
      <div className="bg-blue-500/10 text-blue-300 px-2 py-0.5">{hunk.header}</div>
      {hunk.lines.map((line, i) => {
        const cls =
          line.kind === "addition" ? "bg-green-500/10 text-green-300" :
          line.kind === "deletion" ? "bg-red-500/10 text-red-300" :
          "text-foreground/70";
        const prefix = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
        return (
          <div key={i} className={`px-2 whitespace-pre-wrap break-all ${cls}`}>
            {prefix}{line.content}
          </div>
        );
      })}
    </div>
  );
}

// ── File diff entry ───────────────────────────────────────────────────────────

function FileDiffRow({
  file, open, onToggle, onFileClick, indent = 0, treeMode = false,
}: {
  file: FileDiff;
  open: boolean;
  onToggle: () => void;
  onFileClick?: (file: FileDiff) => void;
  indent?: number;
  treeMode?: boolean;
}) {
  const parts = file.path.split("/");
  const filename = parts[parts.length - 1] ?? file.path;

  return (
    <div
      className="border border-border rounded mb-1.5"
      style={{ marginLeft: indent * 16 }}
    >
      <div className="flex items-center gap-1 px-1 py-1.5 hover:bg-white/5">
        {/* Chevron always toggles collapse, independent of onFileClick */}
        <button
          className="shrink-0 p-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
          onClick={onToggle}
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        {/* File info — calls onFileClick when set, otherwise falls back to toggle */}
        <div
          className="flex items-center gap-2 flex-1 min-w-0 text-sm cursor-pointer"
          onClick={() => onFileClick ? onFileClick(file) : onToggle()}
        >
          <span className={`text-xs font-mono font-bold shrink-0 ${DIFF_STATUS_COLOR[file.status]}`}>
            {STATUS_LABEL[file.status]}
          </span>
          <span className="font-mono truncate text-foreground/90 text-xs">
            {treeMode ? filename : file.path}
          </span>
          {file.old_path && (
            <span className="text-muted-foreground text-xs shrink-0">← {file.old_path}</span>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-border">
          {file.hunks.map((hunk, i) => <HunkView key={i} hunk={hunk} />)}
          {file.hunks.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Binary or empty file</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Directory row ─────────────────────────────────────────────────────────────

function DirRow({
  node, expanded, onToggle, indent, children,
}: {
  node: DirNode<FileDiff>;
  expanded: boolean;
  onToggle: () => void;
  indent: number;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        className="flex items-center gap-1.5 py-0.5 hover:bg-white/5 rounded text-xs cursor-pointer select-none"
        style={{ paddingLeft: `${8 + indent * 16}px` }}
        onClick={onToggle}
      >
        {expanded
          ? <ChevronDown size={11} className="text-muted-foreground shrink-0" />
          : <ChevronRight size={11} className="text-muted-foreground shrink-0" />}
        {expanded
          ? <FolderOpen size={12} className="text-yellow-400/70 shrink-0" />
          : <Folder size={12} className="text-yellow-400/70 shrink-0" />}
        <span className="text-foreground/75">{node.name}</span>
      </div>
      {expanded && children}
    </>
  );
}

// ── Recursive tree renderer ───────────────────────────────────────────────────

function TreeNodes({
  nodes, openFiles, onToggleFile, expandedDirs, onToggleDir, onFileClick, indent = 0,
}: {
  nodes: TreeNode<FileDiff>[];
  openFiles: Record<string, boolean>;
  onToggleFile: (path: string) => void;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onFileClick?: (file: FileDiff) => void;
  indent?: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "file") {
          return (
            <FileDiffRow
              key={node.file.path}
              file={node.file}
              open={openFiles[node.file.path] ?? true}
              onToggle={() => onToggleFile(node.file.path)}
              onFileClick={onFileClick}
              indent={indent}
              treeMode
            />
          );
        }
        const isExpanded = expandedDirs.has(node.path);
        return (
          <DirRow
            key={node.path}
            node={node}
            expanded={isExpanded}
            onToggle={() => onToggleDir(node.path)}
            indent={indent}
          >
            <TreeNodes
              nodes={node.children}
              openFiles={openFiles}
              onToggleFile={onToggleFile}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              onFileClick={onFileClick}
              indent={indent + 1}
            />
          </DirRow>
        );
      })}
    </>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function DiffViewer({ files, onFileClick }: Props) {
  const [view, setView] = useState<"list" | "tree">("list");
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildFileTree(files), [files]);

  // Reset per-file open state and expanded dirs when the file set changes.
  useEffect(() => {
    setOpenFiles(Object.fromEntries(files.map((f) => [f.path, true])));
  }, [files]);
  useEffect(() => {
    setExpandedDirs(new Set(collectDirPaths(tree)));
  }, [tree]);

  function toggleFile(path: string) {
    // Use ?? true so the first toggle on a not-yet-initialised key closes correctly.
    setOpenFiles((prev) => ({ ...prev, [path]: !(prev[path] ?? true) }));
  }
  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }
  function expandAll() {
    setOpenFiles(Object.fromEntries(files.map((f) => [f.path, true])));
    setExpandedDirs(new Set(collectDirPaths(tree)));
  }
  function collapseAll() {
    setOpenFiles(Object.fromEntries(files.map((f) => [f.path, false])));
    setExpandedDirs(new Set());
  }

  if (files.length === 0) {
    return (
      <div className="text-xs text-muted-foreground px-3 py-2">No changes in this commit.</div>
    );
  }

  return (
    <div className="overflow-hidden flex-1 flex flex-col">
      {/* Toolbar */}
      <div className="shrink-0 px-2 py-1 border-b border-border flex items-center gap-1">
        <div className="flex items-center gap-0.5 bg-white/5 rounded p-0.5">
          {(["list", "tree"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={[
                "text-[10px] capitalize px-1.5 py-0.5 rounded transition-colors",
                view === v
                  ? "bg-white/15 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={expandAll}
          className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
        >
          Expand all
        </button>
        <button
          onClick={collapseAll}
          className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
        >
          Collapse all
        </button>
      </div>

      {/* File list */}
      <div className="overflow-auto flex-1 p-2">
        {view === "list" ? (
          files.map((file) => (
            <FileDiffRow
              key={file.path}
              file={file}
              open={openFiles[file.path] ?? true}
              onToggle={() => toggleFile(file.path)}
              onFileClick={onFileClick}
            />
          ))
        ) : (
          <TreeNodes
            nodes={tree}
            openFiles={openFiles}
            onToggleFile={toggleFile}
            expandedDirs={expandedDirs}
            onToggleDir={toggleDir}
            onFileClick={onFileClick}
          />
        )}
      </div>
    </div>
  );
}
