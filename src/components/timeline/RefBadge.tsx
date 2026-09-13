import { Monitor, Globe, Tag, GitBranch, FolderGit2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { CommitAction } from "./CommitContextMenu";
import { CommitMenuItems } from "./CommitMenuItems";
import { truncateMiddle, worktreeName } from "@/lib/utils";

// Shared action type — also re-exported from RefTree for sidebar use.
export type RefAction =
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "checkout-remote-branch"; remoteBranch: string }
  | { kind: "checkout-tag"; oid: string }
  | { kind: "merge"; oid: string; label: string }
  | { kind: "rebase"; oid: string }
  | { kind: "push"; branchName: string }
  | { kind: "rename-branch"; branchName: string }
  | { kind: "delete-branch"; branchName: string }
  | { kind: "push-tag"; tagName: string }
  | { kind: "delete-tag"; tagName: string }
  | { kind: "create-tag"; oid: string }
  /** Open the branch's other worktree as a tab (activates it if already open). */
  | { kind: "open-worktree"; path: string };

export interface RefGroup {
  name: string;
  /** Full remote tracking name (e.g. "origin/feature") — only set for remote-only branches. */
  trackingName?: string;
  hasLocal: boolean;
  hasRemote: boolean;
  isHead: boolean;
  isTag: boolean;
}

export function groupRefs(
  allRefs: string[],
  localBranches: string[],
  remoteBranches: string[],
  headBranch: string | null,
  pushedTagNames?: Set<string>,
): RefGroup[] {
  const groups: RefGroup[] = [];
  const covered = new Set<string>(["HEAD"]);

  // Local branches merged with their matching remote tracking branches
  for (const local of localBranches) {
    covered.add(local);
    const matched = remoteBranches.filter((r) => {
      const slash = r.indexOf("/");
      return slash !== -1 && r.slice(slash + 1) === local;
    });
    matched.forEach((r) => covered.add(r));
    groups.push({ name: local, hasLocal: true, hasRemote: matched.length > 0, isHead: local === headBranch, isTag: false });
  }

  // Remote-only branches (no corresponding local branch)
  for (const remote of remoteBranches) {
    if (covered.has(remote)) continue;
    covered.add(remote); // mark as handled before the /HEAD skip so it doesn't leak below
    if (remote.endsWith("/HEAD")) continue;
    const slash = remote.indexOf("/");
    const name = slash !== -1 ? remote.slice(slash + 1) : remote;
    groups.push({ name, trackingName: remote, hasLocal: false, hasRemote: true, isHead: false, isTag: false });
  }

  // Other refs (tags, etc.) not yet represented — tags always live in
  // refs/tags/ i.e. the local repo, so hasLocal = true. hasRemote = true
  // when the caller confirms the tag has been pushed to a remote.
  for (const ref of allRefs) {
    if (covered.has(ref) || ref.endsWith("/HEAD")) continue;
    const isPushed = pushedTagNames?.has(ref) ?? false;
    groups.push({ name: ref, hasLocal: true, hasRemote: isPushed, isHead: false, isTag: true });
  }

  groups.sort((a, b) => (b.isHead ? 1 : 0) - (a.isHead ? 1 : 0));
  return groups;
}

interface Props extends RefGroup {
  /** OID of the commit this badge sits on — enables checkout / merge / rebase actions. */
  oid?: string;
  /** Ref-specific actions (push, delete, checkout-tag). */
  onAction?: (action: RefAction) => void;
  /** Commit-level actions shared with the row context menu. */
  onCommitAction?: (action: CommitAction) => void;
  /** Commit summary — needed for cherry-pick label. */
  commitSummary?: string;
  /**
   * Max badge width in px, driven by the caller's available space (e.g. the
   * resizable refs column). Falls back to a fixed 124px when omitted. The
   * name is only middle-truncated as far as this budget actually requires —
   * widening the column shows more of the name instead of always cutting at
   * a fixed character count.
   */
  maxWidth?: number;
  /**
   * Set when this local branch is checked out in ANOTHER git worktree. The
   * backend rejects checkout/delete/reset of such a branch, so the menu
   * disables those and offers "Open worktree" instead.
   */
  worktreePath?: string | null;
}

function BadgeMenu({
  name, trackingName, hasLocal, isHead, isTag,
  oid, onAction, onCommitAction, commitSummary, children, worktreePath,
}: Props & { children: React.ReactNode }) {
  const act = onAction;
  const ca  = onCommitAction;
  // Set for any badge (local or remote-only) whose branch is checked out in
  // another worktree — CommitRow resolves worktreePath by local branch name
  // for both, so a remote-only badge can be "held" too.
  const isElsewhere = !isTag && !!worktreePath;

  // Build the checkout item scoped to this specific badge's branch/tag.
  // Held branches render their own "Open worktree" item first instead (below),
  // so this slot is null for them.
  const checkoutSlot: React.ReactNode = isHead ? null
    : isTag ? (
        oid && ca
          ? <ContextMenuItem onClick={() => ca({ kind: "checkout-detached", oid })}><GitBranch />Checkout (detached)</ContextMenuItem>
          : null
      )
    : isElsewhere ? null
    : hasLocal ? (
        ca ? (
          <ContextMenuItem onClick={() => ca({ kind: "checkout-branch", branchName: name })}>
            <GitBranch />
            Checkout <span className="ml-auto font-mono text-xs text-muted-foreground">{name}</span>
          </ContextMenuItem>
        ) : null
      )
    : (ca && trackingName
        ? <ContextMenuItem onClick={() => ca({ kind: "checkout-remote-branch", remoteBranch: trackingName })}>
            <GitBranch />
            Checkout <span className="ml-auto font-mono text-xs text-muted-foreground">{name}</span>
          </ContextMenuItem>
        : null);

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">

        {/* ── Open worktree (held branches only) — first, ahead of the shared
            commit-level items, mirroring where Checkout would sit. ────── */}
        {isElsewhere && act && (
          <>
            <ContextMenuItem onClick={() => act({ kind: "open-worktree", path: worktreePath! })}>
              <FolderGit2 />
              Open worktree <span className="ml-auto font-mono text-xs text-muted-foreground">{worktreeName(worktreePath!)}</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}

        {/* ── Shared commit-level items ─────────────────────────── */}
        {oid && ca ? (
          <CommitMenuItems
            oid={oid}
            isHead={isHead}
            mergeLabel={name}
            commitSummary={commitSummary}
            onAction={ca}
            extraCopyItems={
              <ContextMenuItem onClick={() => navigator.clipboard.writeText(name)}>
                Copy name
              </ContextMenuItem>
            }
            checkoutSlot={checkoutSlot}
            hideCreateTag={isTag}
            hideMergeRebase={isTag}
            hideReset={isHead}
            pluginContext={
              isTag ? undefined : { surface: "branchContextMenu", extra: { branchName: name } }
            }
          />
        ) : (
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(name)}>
            Copy name
          </ContextMenuItem>
        )}

        {/* ── Badge-specific: push ──────────────────────────────── */}
        {isTag
          ? act && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => act({ kind: "push-tag", tagName: name })}>
                  Push tag…
                </ContextMenuItem>
              </>
            )
          : hasLocal
          ? act && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => act({ kind: "push", branchName: name })}>
                  Push…
                </ContextMenuItem>
              </>
            )
          : null}

        {/* ── Badge-specific: delete ────────────────────────────── */}
        {isTag && act && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => act({ kind: "delete-tag", tagName: name })}
              className="text-destructive focus:text-destructive"
            >
              Delete {name}
            </ContextMenuItem>
          </>
        )}
        {!isTag && hasLocal && act && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => act({ kind: "rename-branch", branchName: name })}>
              Rename…
            </ContextMenuItem>
          </>
        )}
        {!isTag && hasLocal && !isHead && !isElsewhere && act && (
          <ContextMenuItem
            onClick={() => act({ kind: "delete-branch", branchName: name })}
            className="text-destructive focus:text-destructive"
          >
            Delete {name}
          </ContextMenuItem>
        )}

      </ContextMenuContent>
    </ContextMenu>
  );
}

export function RefBadge({ name, trackingName, hasLocal, hasRemote, isHead, isTag, oid, onAction, onCommitAction, commitSummary, maxWidth, worktreePath }: Props) {
  const base = "inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-mono min-w-0";
  const width = maxWidth ?? 124;

  let badge: React.ReactNode;

  // Middle-truncate so the prefix and ticket-id tail both stay readable, and
  // expose the full name via the native hover tooltip. Character budget scales
  // with the available pixel width (font is monospace, so px→chars is linear)
  // instead of always cutting at a fixed length regardless of room.
  const shown = truncateMiddle(name, Math.max(6, Math.floor((width - 28 - (worktreePath ? 10 : 0)) / 6.2)));
  const heldName = worktreePath ? worktreeName(worktreePath) : null;
  // A badge with a worktree path can never really be this tab's current
  // branch, even if `isHead` says otherwise (mirrors the RefTree.tsx fix for
  // the backend's commit-oid-based `is_head`/`isHead` flag).
  const effectiveHead = isHead && !worktreePath;

  // Double-click means "go to this branch": held → open its worktree tab;
  // a normal local branch → the checkout dialog; a remote-only badge →
  // checkout that remote branch. HEAD and tag badges do nothing (but still
  // stop the click from also reaching the row).
  function handleDoubleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (effectiveHead || isTag) return;
    if (worktreePath) {
      onAction?.({ kind: "open-worktree", path: worktreePath });
    } else if (hasLocal) {
      onCommitAction?.({ kind: "checkout-branch", branchName: name });
    } else if (trackingName) {
      onCommitAction?.({ kind: "checkout-remote-branch", remoteBranch: trackingName });
    }
  }

  if (effectiveHead) {
    badge = (
      <span className={`${base} bg-teal-500/20 text-teal-300 border border-teal-500/40 font-medium`} style={{ maxWidth: width }} title={name} onDoubleClick={handleDoubleClick}>
        <span className="text-[8px] mr-0.5 opacity-80">✓</span>
        <span className="overflow-hidden whitespace-nowrap">{shown}</span>
        {hasLocal  && <Monitor size={8} className="shrink-0 opacity-50 ml-0.5" />}
        {hasRemote && <Globe size={8} className="shrink-0 opacity-50 ml-0.5" />}
      </span>
    );
  } else if (isTag) {
    // ── Tag badge ──────────────────────────────────────────────────────────
    badge = (
      <span className={`${base} bg-amber-500/12 text-amber-300/85 border border-amber-500/20`} style={{ maxWidth: width }} title={name} onDoubleClick={handleDoubleClick}>
        <Tag size={8} className="shrink-0 opacity-60 mr-0.5" />
        <span className="overflow-hidden whitespace-nowrap">{shown}</span>
        {hasLocal  && <Monitor size={8} className="shrink-0 opacity-40 ml-0.5" />}
        {hasRemote && <Globe   size={8} className="shrink-0 opacity-40" />}
      </span>
    );
  } else {
    // ── Branch badge ───────────────────────────────────────────────────────
    const colorClass =
      hasLocal && hasRemote
        ? "bg-indigo-500/15 text-indigo-300/90 border border-indigo-500/25"
        : hasLocal
        ? "bg-slate-500/12 text-slate-300/80 border border-slate-500/20"
        : "bg-slate-600/10 text-slate-400/70 border border-slate-500/15";

    badge = (
      <span className={`${base} ${colorClass}`} style={{ maxWidth: width }} title={name} onDoubleClick={handleDoubleClick}>
        <span className="overflow-hidden whitespace-nowrap">{shown}</span>
        {hasLocal  && <Monitor size={8} className="shrink-0 opacity-40 ml-0.5" />}
        {hasRemote && <Globe   size={8} className="shrink-0 opacity-40" />}
        {worktreePath && (
          <span className="shrink-0 inline-flex ml-0.5">
            <FolderGit2 size={8} className="opacity-60" />
          </span>
        )}
        {heldName && <span className="sr-only">, checked out in worktree {heldName}</span>}
      </span>
    );
  }

  return (
    <BadgeMenu
      name={name} trackingName={trackingName}
      hasLocal={hasLocal} hasRemote={hasRemote}
      isHead={effectiveHead} isTag={isTag}
      oid={oid} onAction={onAction}
      onCommitAction={onCommitAction} commitSummary={commitSummary}
      worktreePath={worktreePath}
    >
      {badge}
    </BadgeMenu>
  );
}
