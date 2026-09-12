import { useState, useMemo, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  PlusCircle, MinusCircle, ChevronsUp, GitCommitHorizontal,
  Archive, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ipc, type FileStatus } from "@/lib/ipc";
import { useFileStatus, useHeadInfo, useRefs, useRefreshRepo } from "@/lib/queries";
import { useStore } from "@/lib/store";
import { buildFileTree, collectDirPaths, type TreeNode, type DirNode } from "@/lib/fileTree";
import { DirRow as BaseDirRow, FileRow as BaseFileRow, handleFileListKeyDown } from "@/components/files/FileRow";
import { SegmentedToggle } from "@/components/SegmentedToggle";

type Section = "staged" | "unstaged";

interface Props {
  repoId: string;
  onCommitSuccess: () => void;
  onFileClick?: (path: string, section: Section) => void;
  /** The file open in the diff panel, highlighted in its section. */
  selectedFile?: { path: string; section: Section } | null;
}

const VIEW_OPTIONS = [
  { value: "path", label: "Path" },
  { value: "tree", label: "Tree" },
] as const;

const SECTION_LABEL = "px-3 pt-2 pb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";
const ROW_ACTION = "flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-white/[0.07] disabled:opacity-30";

// ── Tree helpers ─────────────────────────────────────────────────────────────

function collectPaths(node: TreeNode<FileStatus>): string[] {
  if (node.kind === "file") return [node.file.path];
  return node.children.flatMap(collectPaths);
}

// ── FileRow ──────────────────────────────────────────────────────────────────

function FileRow({
  file, section, onAction, onDiscard, onRowClick, disabled, depth = 0, treeMode, selected,
}: {
  file: FileStatus;
  section: Section;
  onAction: () => void;
  onDiscard: () => void;
  onRowClick?: () => void;
  disabled: boolean;
  depth?: number;
  treeMode: boolean;
  selected: boolean;
}) {
  const statusKind = section === "staged" ? file.staged : file.unstaged;
  const actionLabel = section === "staged" ? "Unstage file" : "Stage file";

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <BaseFileRow
          path={file.path}
          status={statusKind}
          treeMode={treeMode}
          depth={depth}
          selected={selected}
          onOpen={onRowClick}
          revealTrailing
          trailing={
            <button
              type="button"
              onClick={onAction}
              disabled={disabled}
              aria-label={`${actionLabel} ${file.path}`}
              title={actionLabel}
              className={ROW_ACTION}
            >
              {section === "staged" ? <MinusCircle size={13} /> : <PlusCircle size={13} />}
            </button>
          }
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={onDiscard} disabled={disabled}>
          <Trash2 />
          Discard changes
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ── DirRow ────────────────────────────────────────────────────────────────────

function DirRow({
  node, section, expanded, onToggle, onBatch, onDiscardBatch, disabled, depth, children,
}: {
  node: DirNode<FileStatus>;
  section: Section;
  expanded: boolean;
  onToggle: () => void;
  onBatch: (paths: string[]) => void;
  onDiscardBatch: (paths: string[]) => void;
  disabled: boolean;
  depth: number;
  children: React.ReactNode;
}) {
  const actionLabel = section === "staged" ? "Unstage folder" : "Stage folder";
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <BaseDirRow
            name={node.name}
            expanded={expanded}
            onToggle={onToggle}
            depth={depth}
            revealTrailing
            trailing={
              <button
                type="button"
                onClick={() => onBatch(collectPaths(node))}
                disabled={disabled}
                aria-label={`${actionLabel} ${node.path}`}
                title={actionLabel}
                className={ROW_ACTION}
              >
                {section === "staged" ? <MinusCircle size={12} /> : <PlusCircle size={12} />}
              </button>
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem variant="destructive" onClick={() => onDiscardBatch(collectPaths(node))} disabled={disabled}>
            <Trash2 />
            Discard folder changes
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded && children}
    </>
  );
}

// ── TreeNodes (recursive) ────────────────────────────────────────────────────

function TreeNodes({
  nodes, section, expandedDirs, toggleDir, onBatch, onSingleFile, onDiscard, onDiscardBatch, onFileClick, selectedPath, disabled, depth = 0,
}: {
  nodes: TreeNode<FileStatus>[];
  section: Section;
  expandedDirs: Set<string>;
  toggleDir: (p: string) => void;
  onBatch: (paths: string[]) => void;
  onSingleFile: (path: string) => void;
  onDiscard: (path: string) => void;
  onDiscardBatch: (paths: string[]) => void;
  onFileClick?: (path: string) => void;
  selectedPath: string | null;
  disabled: boolean;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "file") {
          return (
            <FileRow
              key={node.file.path + "-" + section}
              file={node.file}
              section={section}
              onAction={() => onSingleFile(node.file.path)}
              onDiscard={() => onDiscard(node.file.path)}
              onRowClick={() => onFileClick?.(node.file.path)}
              disabled={disabled}
              depth={depth}
              selected={node.file.path === selectedPath}
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
            onDiscardBatch={onDiscardBatch}
            disabled={disabled}
            depth={depth}
          >
            <TreeNodes
              nodes={node.children}
              section={section}
              expandedDirs={expandedDirs}
              toggleDir={toggleDir}
              onBatch={onBatch}
              onSingleFile={onSingleFile}
              onDiscard={onDiscard}
              onDiscardBatch={onDiscardBatch}
              onFileClick={onFileClick}
              selectedPath={selectedPath}
              disabled={disabled}
              depth={depth + 1}
            />
          </DirRow>
        );
      })}
    </>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function StagingPanel({ repoId, onCommitSuccess, onFileClick, selectedFile = null }: Props) {
  const qc = useQueryClient();
  const { data: files = [], isLoading } = useFileStatus(repoId);
  const refresh = useRefreshRepo(repoId);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shared with the commit panel's file list — one Path/Tree preference.
  const view = useStore((s) => s.fileListView);
  const setViewPref = useStore((s) => s.setViewPref);
  const selectedStaged = selectedFile?.section === "staged" ? selectedFile.path : null;
  const selectedUnstaged = selectedFile?.section === "unstaged" ? selectedFile.path : null;
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [discardArmed, setDiscardArmed] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [stashName, setStashName] = useState("");
  const [stashError, setStashError] = useState<string | null>(null);

  // Auto-disarm the discard button after 3 s if not confirmed.
  useEffect(() => {
    if (!discardArmed) return;
    const t = setTimeout(() => setDiscardArmed(false), 3000);
    return () => clearTimeout(t);
  }, [discardArmed]);

  const { data: headInfo } = useHeadInfo(repoId);
  const { data: refs = [] } = useRefs(repoId);
  // True when the HEAD commit is already present in any remote ref — amending
  // would rewrite shared history.
  const headIsPushed = headInfo?.oid != null
    && refs.some((r) => r.kind === "remote_branch" && r.target_oid === headInfo.oid);

  const staged   = files.filter((f) => f.staged !== null);
  const unstaged = files.filter((f) => f.unstaged !== null);
  const stagedTree   = useMemo(() => buildFileTree(staged),   [staged]);
  const unstagedTree = useMemo(() => buildFileTree(unstaged), [unstaged]);

  // Folders open the first time they appear (same as the commit file list), so
  // the tree never hides the file open in the diff panel. Ones the user closed
  // stay closed across status polls.
  const seenDirsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = [...collectDirPaths(stagedTree), ...collectDirPaths(unstagedTree)]
      .filter((d) => !seenDirsRef.current.has(d));
    if (fresh.length === 0) return;
    for (const d of fresh) seenDirsRef.current.add(d);
    setExpandedDirs((prev) => new Set([...prev, ...fresh]));
  }, [stagedTree, unstagedTree]);

  const disabled = committing || working;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["staging", repoId] });
    qc.invalidateQueries({ queryKey: ["status", repoId] });
    qc.invalidateQueries({ queryKey: ["workdir-diff", repoId] });
  }

  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  async function stageFile(path: string) {
    try { await ipc.stageFile(repoId, path); invalidate(); }
    catch (e) { setError(String(e)); }
  }
  async function unstageFile(path: string) {
    try { await ipc.unstageFile(repoId, path); invalidate(); }
    catch (e) { setError(String(e)); }
  }
  async function discardFile(path: string) {
    setWorking(true);
    try { await ipc.discardFile(repoId, path); invalidate(); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }
  async function discardBatch(paths: string[]) {
    setWorking(true);
    try { await ipc.discardPaths(repoId, paths); invalidate(); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }

  async function stagePaths(paths: string[]) {
    setWorking(true);
    try { await ipc.stagePaths(repoId, paths); invalidate(); } finally { setWorking(false); }
  }
  async function unstagePaths(paths: string[]) {
    setWorking(true);
    try { await ipc.unstagePaths(repoId, paths); invalidate(); } finally { setWorking(false); }
  }

  async function handleStageAll() {
    setWorking(true);
    try { await ipc.stageAll(repoId); invalidate(); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }

  async function handleStash(message: string) {
    setWorking(true);
    setStashError(null);
    try {
      await ipc.stashPush(repoId, message.trim());
      setStashOpen(false);
      setStashName("");
      refresh();
    } catch (e) {
      setStashError(String(e));
    } finally {
      setWorking(false);
    }
  }

  async function handleDiscard() {
    if (!discardArmed) { setDiscardArmed(true); return; }
    setDiscardArmed(false);
    setWorking(true);
    setError(null);
    try { await ipc.discardAll(repoId); refresh(); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }

  async function toggleAmend() {
    if (!amend) {
      // Entering amend mode — pre-fill fields from the HEAD commit message.
      // Only enable amend if the fetch succeeds; surface errors otherwise.
      setError(null);
      try {
        const head = await ipc.getHeadInfo(repoId);
        if (head.oid === null) throw new Error("this repository has no commits yet");
        const commit = await ipc.getCommit(repoId, head.oid);
        setSummary(commit.summary);
        setDescription(commit.body);
        setAmend(true);
      } catch (e) {
        setError(`Cannot enable amend: ${String(e)}`);
      }
    } else {
      setAmend(false);
    }
  }

  async function handleCommit() {
    const msg = summary.trim();
    if (!msg) return;
    if (!amend && staged.length === 0) return;
    const full = description.trim() ? `${msg}\n\n${description.trim()}` : msg;
    setCommitting(true);
    setError(null);
    try {
      if (amend) {
        await ipc.amendCommit(repoId, full);
      } else {
        await ipc.doCommit(repoId, full);
      }
      setSummary("");
      setDescription("");
      setAmend(false);
      onCommitSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  const canCommit = amend
    ? summary.trim().length > 0 && !committing
    : staged.length > 0 && summary.trim().length > 0 && !committing;

  return (
    <div className="flex flex-col h-full border-l border-border text-sm overflow-hidden">
      {/* Header */}
      <div className="shrink-0 h-9 flex items-center justify-between gap-2 px-3 border-b border-border">
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.12em] shrink-0">
          Changes
        </h2>

        <SegmentedToggle
          label="File list view"
          value={view}
          options={VIEW_OPTIONS}
          onChange={(v) => setViewPref("fileListView", v)}
        />

        <div className="flex items-center gap-0.5 ml-auto">
          {/* Stash */}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs gap-1 shrink-0"
            onClick={() => { setStashError(null); setStashOpen(true); }}
            disabled={staged.length === 0 && unstaged.length === 0 || disabled}
            title="Stash all changes"
            aria-label="Stash all changes"
          >
            <Archive size={12} />
          </Button>

          {/* Discard — two-step armed confirmation */}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDiscard}
            disabled={staged.length === 0 && unstaged.length === 0 || disabled}
            title={discardArmed ? "Click again to confirm discard" : "Discard all changes (including untracked files)"}
            aria-label={discardArmed ? "Confirm: discard all changes" : "Discard all changes, including untracked files"}
            className={[
              "h-6 px-2 text-xs gap-1 shrink-0 transition-colors",
              discardArmed ? "text-destructive hover:text-destructive" : "",
            ].join(" ")}
          >
            {discardArmed ? <span className="text-[10px]">Discard?</span> : <Trash2 size={12} />}
          </Button>

          {/* Stage All */}
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
      </div>

      {/* File lists */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-1" onKeyDown={handleFileListKeyDown}>
        {isLoading && (
          <p className="text-xs text-muted-foreground px-3 py-2">Loading…</p>
        )}

        {staged.length > 0 && (
          <section aria-label="Staged files">
            <h3 className={SECTION_LABEL}>
              Staged <span className="font-normal tabular-nums text-muted-foreground/70">{staged.length}</span>
            </h3>
            {view === "path" ? staged.map((f) => (
              <FileRow
                key={f.path + "-staged"}
                file={f} section="staged"
                onAction={() => unstageFile(f.path)}
                onDiscard={() => discardFile(f.path)}
                onRowClick={() => onFileClick?.(f.path, "staged")}
                selected={f.path === selectedStaged}
                disabled={disabled} treeMode={false}
              />
            )) : (
              <TreeNodes
                nodes={stagedTree} section="staged"
                expandedDirs={expandedDirs} toggleDir={toggleDir}
                onBatch={unstagePaths} onSingleFile={unstageFile}
                onDiscard={discardFile} onDiscardBatch={discardBatch}
                onFileClick={(p) => onFileClick?.(p, "staged")}
                selectedPath={selectedStaged}
                disabled={disabled}
              />
            )}
          </section>
        )}

        {unstaged.length > 0 && (
          <section aria-label="Unstaged files" className={staged.length > 0 ? "mt-2" : ""}>
            <h3 className={SECTION_LABEL}>
              Unstaged <span className="font-normal tabular-nums text-muted-foreground/70">{unstaged.length}</span>
            </h3>
            {view === "path" ? unstaged.map((f) => (
              <FileRow
                key={f.path + "-unstaged"}
                file={f} section="unstaged"
                onAction={() => stageFile(f.path)}
                onDiscard={() => discardFile(f.path)}
                onRowClick={() => onFileClick?.(f.path, "unstaged")}
                selected={f.path === selectedUnstaged}
                disabled={disabled} treeMode={false}
              />
            )) : (
              <TreeNodes
                nodes={unstagedTree} section="unstaged"
                expandedDirs={expandedDirs} toggleDir={toggleDir}
                onBatch={stagePaths} onSingleFile={stageFile}
                onDiscard={discardFile} onDiscardBatch={discardBatch}
                onFileClick={(p) => onFileClick?.(p, "unstaged")}
                selectedPath={selectedUnstaged}
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
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleCommit(); }}
          placeholder="Description (optional)…"
          rows={2}
          className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
          <input
            type="checkbox"
            checked={amend}
            onChange={toggleAmend}
            disabled={disabled}
            className="accent-primary"
          />
          Amend last commit
        </label>
        {amend && headIsPushed && (
          <p className="text-xs text-yellow-500/80">
            ⚠ This commit has been pushed — amending will rewrite shared history.
          </p>
        )}
        {amend && staged.length === 0 && (
          <p className="text-xs text-muted-foreground/70">
            No staged changes — amending message only.
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          size="sm"
          className="w-full gap-1.5"
          onClick={handleCommit}
          disabled={!canCommit}
        >
          <GitCommitHorizontal size={13} />
          {amend
            ? "Amend Commit"
            : `Commit${staged.length > 0 ? ` ${staged.length} file${staged.length !== 1 ? "s" : ""}` : ""}`}
        </Button>
      </div>

      <Dialog open={stashOpen} onOpenChange={(o) => { if (!o) { setStashOpen(false); setStashName(""); setStashError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stash changes</DialogTitle>
            <DialogDescription>
              Save your working changes to a stash. Give it an optional name to find it later.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Stash name (optional)"
            value={stashName}
            onChange={(e) => setStashName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleStash(stashName)}
            autoFocus
          />
          {stashError && <p className="text-xs text-destructive break-words">{stashError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setStashOpen(false); setStashName(""); }} disabled={working}>
              Cancel
            </Button>
            <Button onClick={() => handleStash(stashName)} disabled={working}>
              {working ? "Stashing…" : "Stash"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
