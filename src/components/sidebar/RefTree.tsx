import { useState, useEffect, useMemo } from "react";
import { GitBranch, Globe, Tag, ChevronRight, FolderGit2 } from "lucide-react";
import type { RefInfo } from "@/lib/ipc";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { RefAction } from "@/components/timeline/RefBadge";
import { usePluginRegistry, commandsForSurface } from "@/lib/plugins/registry";
import { usePluginRunner } from "@/components/plugins/PluginRunnerProvider";
import { truncateMiddle, worktreeName } from "@/lib/utils";

export type { RefAction };

/** Plugin commands contributed to the branch context menu. */
function BranchPluginItems({ branchName }: { branchName: string }) {
  const runner = usePluginRunner();
  const plugins = usePluginRegistry((s) => s.plugins);
  const cmds = commandsForSurface(plugins, "branchContextMenu");
  if (cmds.length === 0) return null;
  return (
    <>
      <ContextMenuSeparator />
      {cmds.map(({ pluginId, command }) => (
        <ContextMenuItem
          key={`${pluginId}:${command.id}`}
          onClick={() => runner.run(pluginId, command, "branchContextMenu", { branchName })}
        >
          {command.title}
        </ContextMenuItem>
      ))}
    </>
  );
}

const GROUP_META = {
  Branches: { icon: GitBranch },
  Remotes:  { icon: Globe },
  Tags:     { icon: Tag },
} as const;

interface GroupProps {
  label: keyof typeof GROUP_META;
  refs: RefInfo[];
  filter?: string;
  onSelect?: (ref: RefInfo) => void;
  onRefAction?: (action: RefAction) => void;
  /** Local branch shorthand -> the worktree path it's held in. Used by the
   * Remotes group to detect when a remote's local counterpart is held. */
  heldLocalMap: Map<string, string>;
}

/** Local counterpart name of a remote shorthand, e.g. "origin/feature" -> "feature". */
function localNameOf(remoteShorthand: string): string {
  const slash = remoteShorthand.indexOf("/");
  return slash !== -1 ? remoteShorthand.slice(slash + 1) : remoteShorthand;
}

function RefGroup({ label, refs, filter, onSelect, onRefAction, heldLocalMap }: GroupProps) {
  const [open, setOpen] = useState(true);
  const { icon: Icon } = GROUP_META[label];

  useEffect(() => {
    if (filter) setOpen(true);
  }, [filter]);

  const visible = filter
    ? refs.filter((r) => r.shorthand.toLowerCase().includes(filter.toLowerCase()))
    : refs;

  if (visible.length === 0) return null;

  return (
    <div>
      <button
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground/55 uppercase tracking-[0.12em] hover:text-muted-foreground/80 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon size={10} className="opacity-70 shrink-0" />
        <span>{label}</span>
        <span className="ml-auto flex items-center gap-1">
          <span className="text-[9px] opacity-40 tabular-nums">{visible.length}</span>
          <ChevronRight
            size={10}
            className={`opacity-35 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>

      {open && (
        <ul className="pb-0.5">
          {visible.map((ref) => {
            // Held worktree path for this row: Branches carry it directly;
            // Remotes look it up via their local counterpart.
            const heldPath =
              label === "Branches"
                ? ref.worktree_path ?? undefined
                : label === "Remotes"
                ? heldLocalMap.get(localNameOf(ref.shorthand))
                : undefined;

            // The backend's `is_head` also flags a branch whose tip commit
            // happens to equal HEAD's commit (e.g. `git worktree add ../x -b
            // feat` right after creating it) — not just the tab's actual
            // current branch. A branch with a worktree path can never be
            // *this* tab's current branch, so `heldPath` always wins.
            const effectiveHead = ref.is_head && !heldPath;

            function handleDoubleClick() {
              if (!onRefAction) return;
              if (label === "Branches") {
                if (effectiveHead) return;
                if (heldPath) onRefAction({ kind: "open-worktree", path: heldPath });
                else onRefAction({ kind: "checkout-branch", branchName: ref.shorthand });
              } else if (label === "Remotes") {
                if (heldPath) onRefAction({ kind: "open-worktree", path: heldPath });
                else onRefAction({ kind: "checkout-remote-branch", remoteBranch: ref.shorthand });
              }
              // Tags: no double-click.
            }

            const btn = (
              <button
                className={[
                  "group w-full text-left px-3 py-[3px] text-[12px] truncate rounded-sm flex items-center justify-between gap-2 transition-colors duration-75",
                  effectiveHead
                    ? "text-teal-300/90 font-medium hover:bg-teal-500/8"
                    : "text-foreground/55 hover:text-foreground/80 hover:bg-white/[0.05]",
                ].join(" ")}
                onClick={() => onSelect?.(ref)}
                onDoubleClick={
                  (label === "Branches" && !effectiveHead) || label === "Remotes"
                    ? handleDoubleClick
                    : undefined
                }
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={[
                    "w-1.5 h-1.5 rounded-full shrink-0 transition-colors",
                    effectiveHead ? "bg-teal-400 shadow-[0_0_4px_rgba(45,212,191,0.5)]" : "bg-transparent",
                  ].join(" ")} />
                  <span className="truncate">{ref.shorthand}</span>
                </div>
                {label === "Tags" && !ref.is_pushed && (
                  <span className="text-[9px] font-semibold text-amber-500/80 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 shrink-0 select-none tracking-wide uppercase">
                    local
                  </span>
                )}
                {label === "Branches" && ref.worktree_path && (
                  <>
                    <span
                      data-testid="worktree-indicator"
                      aria-hidden
                      className="shrink-0 inline-flex items-center gap-1 max-w-[45%] font-mono text-[10px] text-foreground/60 group-hover:text-foreground/80"
                    >
                      <FolderGit2 size={10} aria-hidden />
                      <span className="truncate">{truncateMiddle(worktreeName(ref.worktree_path), 16)}</span>
                    </span>
                    <span className="sr-only">, checked out in worktree {worktreeName(ref.worktree_path)}</span>
                  </>
                )}
              </button>
            );

            const menuContent = buildMenu(label, ref, onRefAction, heldPath);

            if (!menuContent) {
              return <li key={ref.name}>{btn}</li>;
            }

            return (
              <li key={ref.name}>
                <ContextMenu>
                  <ContextMenuTrigger>{btn}</ContextMenuTrigger>
                  <ContextMenuContent>
                    {menuContent}
                    {label === "Branches" && <BranchPluginItems branchName={ref.shorthand} />}
                  </ContextMenuContent>
                </ContextMenu>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function buildMenu(
  label: keyof typeof GROUP_META,
  ref: RefInfo,
  onRefAction?: (action: RefAction) => void,
  heldPath?: string,
): React.ReactNode | null {
  if (!onRefAction) return null;

  if (label === "Branches") {
    // See `effectiveHead` above: a branch with a worktree path can never be
    // this tab's actual current branch, even if the backend's `is_head`
    // (commit-oid based) says otherwise.
    if (ref.is_head && !heldPath) {
      return (
        <>
          <ContextMenuItem disabled className="text-muted-foreground">
            Current branch
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(ref.shorthand)}>
            Copy branch name
          </ContextMenuItem>
          <ContextMenuSeparator />
          {ref.target_oid && (
            <ContextMenuItem onClick={() => onRefAction({ kind: "create-tag", oid: ref.target_oid! })}>
              Create tag here…
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => onRefAction({ kind: "push", branchName: ref.shorthand })}>
            Push…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onRefAction({ kind: "rename-branch", branchName: ref.shorthand })}>
            Rename…
          </ContextMenuItem>
        </>
      );
    }
    const held = !!ref.worktree_path;
    return (
      <>
        {held ? (
          <ContextMenuItem onClick={() => onRefAction({ kind: "open-worktree", path: ref.worktree_path! })}>
            Open worktree <span className="ml-auto font-mono text-xs text-muted-foreground">{worktreeName(ref.worktree_path!)}</span>
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onClick={() => onRefAction({ kind: "checkout-branch", branchName: ref.shorthand })}>
            Checkout {ref.shorthand}
          </ContextMenuItem>
        )}
        {ref.target_oid && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onRefAction({ kind: "merge", oid: ref.target_oid!, label: ref.shorthand })}>
              Merge into current
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRefAction({ kind: "rebase", oid: ref.target_oid! })}>
              Rebase current onto {ref.shorthand}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(ref.shorthand)}>
          Copy branch name
        </ContextMenuItem>
        <ContextMenuSeparator />
        {ref.target_oid && (
          <ContextMenuItem onClick={() => onRefAction({ kind: "create-tag", oid: ref.target_oid! })}>
            Create tag here…
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => onRefAction({ kind: "push", branchName: ref.shorthand })}>
          Push…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onRefAction({ kind: "rename-branch", branchName: ref.shorthand })}>
          Rename…
        </ContextMenuItem>
        {!held && (
          <ContextMenuItem
            onClick={() => onRefAction({ kind: "delete-branch", branchName: ref.shorthand })}
            className="text-destructive focus:text-destructive"
          >
            Delete {ref.shorthand}
          </ContextMenuItem>
        )}
      </>
    );
  }

  if (label === "Remotes" && ref.target_oid) {
    return (
      <>
        {heldPath ? (
          <ContextMenuItem onClick={() => onRefAction({ kind: "open-worktree", path: heldPath })}>
            Open worktree <span className="ml-auto font-mono text-xs text-muted-foreground">{worktreeName(heldPath)}</span>
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onClick={() => onRefAction({ kind: "checkout-remote-branch", remoteBranch: ref.shorthand })}>
            Checkout {ref.shorthand}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onRefAction({ kind: "merge", oid: ref.target_oid!, label: ref.shorthand })}>
          Merge into current
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onRefAction({ kind: "rebase", oid: ref.target_oid! })}>
          Rebase current onto {ref.shorthand}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(ref.shorthand)}>
          Copy branch name
        </ContextMenuItem>
      </>
    );
  }

  if (label === "Tags") {
    return (
      <>
        {ref.target_oid && (
          <ContextMenuItem onClick={() => onRefAction({ kind: "checkout-tag", oid: ref.target_oid! })}>
            Checkout (detached)
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => onRefAction({ kind: "push-tag", tagName: ref.shorthand })}>
          Push tag…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => onRefAction({ kind: "delete-tag", tagName: ref.shorthand })}
          className="text-destructive focus:text-destructive"
        >
          Delete {ref.shorthand}
        </ContextMenuItem>
      </>
    );
  }

  return null;
}

interface Props {
  refs: RefInfo[];
  filter?: string;
  onSelectRef?: (ref: RefInfo) => void;
  onRefAction?: (action: RefAction) => void;
  /** Rendered between the Branches and Remotes groups — used by the WorktreeList section. */
  afterBranches?: React.ReactNode;
}

export function RefTree({ refs, filter, onSelectRef, onRefAction, afterBranches }: Props) {
  const local  = refs.filter((r) => r.kind === "local_branch");
  const remote = refs.filter((r) => r.kind === "remote_branch");
  const tags   = refs.filter((r) => r.kind === "tag");

  // Local branch shorthand -> the worktree path it's held in. Built once so
  // the Remotes group can replace "Checkout" with "Open worktree" when a
  // remote's local counterpart is checked out elsewhere.
  const heldLocalMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of local) {
      if (r.worktree_path) map.set(r.shorthand, r.worktree_path);
    }
    return map;
  }, [local]);

  return (
    <div className="overflow-auto flex-1 py-1">
      <RefGroup label="Branches" refs={local}  filter={filter} onSelect={onSelectRef} onRefAction={onRefAction} heldLocalMap={heldLocalMap} />
      {afterBranches}
      <RefGroup label="Remotes"  refs={remote} filter={filter} onSelect={onSelectRef} onRefAction={onRefAction} heldLocalMap={heldLocalMap} />
      <RefGroup label="Tags"     refs={tags}   filter={filter} onSelect={onSelectRef} onRefAction={onRefAction} heldLocalMap={heldLocalMap} />
    </div>
  );
}
