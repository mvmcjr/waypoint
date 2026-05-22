import { Monitor, Globe, Tag } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

// Shared action type — also re-exported from RefTree for sidebar use.
export type RefAction =
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "checkout-remote-branch"; remoteBranch: string }
  | { kind: "checkout-tag"; oid: string }
  | { kind: "merge"; oid: string; label: string }
  | { kind: "rebase"; oid: string }
  | { kind: "push"; branchName: string }
  | { kind: "delete-branch"; branchName: string }
  | { kind: "push-tag"; tagName: string }
  | { kind: "delete-tag"; tagName: string };

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
  /** When provided, the context menu shows the full set of ref actions. */
  onAction?: (action: RefAction) => void;
}

function BadgeMenu({
  name, trackingName, hasLocal, isHead, isTag,
  oid, onAction, children,
}: Props & { children: React.ReactNode }) {
  const act = onAction; // alias for brevity

  let menuItems: React.ReactNode;

  if (isHead) {
    menuItems = (
      <>
        <ContextMenuItem disabled className="text-muted-foreground text-xs">
          Current branch
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(name)}>
          Copy name
        </ContextMenuItem>
        {act && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => act({ kind: "push", branchName: name })}>
              Push…
            </ContextMenuItem>
          </>
        )}
      </>
    );
  } else if (isTag) {
    menuItems = (
      <>
        {act && oid && (
          <ContextMenuItem onClick={() => act({ kind: "checkout-tag", oid })}>
            Checkout (detached)
          </ContextMenuItem>
        )}
        {act && (
          <>
            <ContextMenuItem onClick={() => act({ kind: "push-tag", tagName: name })}>
              Push tag…
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(name)}>
          Copy name
        </ContextMenuItem>
        {act && (
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
      </>
    );
  } else if (hasLocal) {
    // Local branch (non-HEAD)
    menuItems = (
      <>
        {act && (
          <ContextMenuItem onClick={() => act({ kind: "checkout-branch", branchName: name })}>
            Checkout {name}
          </ContextMenuItem>
        )}
        {act && oid && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => act({ kind: "merge", oid, label: name })}>
              Merge into current
            </ContextMenuItem>
            <ContextMenuItem onClick={() => act({ kind: "rebase", oid })}>
              Rebase current onto {name}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(name)}>
          Copy name
        </ContextMenuItem>
        {act && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => act({ kind: "push", branchName: name })}>
              Push…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => act({ kind: "delete-branch", branchName: name })}
              className="text-destructive focus:text-destructive"
            >
              Delete {name}
            </ContextMenuItem>
          </>
        )}
      </>
    );
  } else {
    // Remote-only branch
    menuItems = (
      <>
        {act && trackingName && (
          <ContextMenuItem onClick={() => act({ kind: "checkout-remote-branch", remoteBranch: trackingName })}>
            Checkout {name}
          </ContextMenuItem>
        )}
        {act && oid && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => act({ kind: "merge", oid, label: name })}>
              Merge into current
            </ContextMenuItem>
            <ContextMenuItem onClick={() => act({ kind: "rebase", oid })}>
              Rebase current onto {name}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(name)}>
          Copy name
        </ContextMenuItem>
      </>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>{menuItems}</ContextMenuContent>
    </ContextMenu>
  );
}

export function RefBadge({ name, trackingName, hasLocal, hasRemote, isHead, isTag, oid, onAction }: Props) {
  const base = "inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-mono min-w-0 max-w-[124px]";

  let badge: React.ReactNode;

  if (isHead) {
    badge = (
      <span className={`${base} bg-teal-500/20 text-teal-300 border border-teal-500/40 font-medium`}>
        <span className="text-[8px] mr-0.5 opacity-80">✓</span>
        <span className="truncate">{name}</span>
        {hasRemote && <Globe size={8} className="shrink-0 opacity-50 ml-0.5" />}
      </span>
    );
  } else if (isTag) {
    // ── Tag badge ──────────────────────────────────────────────────────────
    badge = (
      <span className={`${base} bg-amber-500/12 text-amber-300/85 border border-amber-500/20`}>
        <Tag size={8} className="shrink-0 opacity-60 mr-0.5" />
        <span className="truncate">{name}</span>
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
      <span className={`${base} ${colorClass}`}>
        <span className="truncate">{name}</span>
        {hasLocal  && <Monitor size={8} className="shrink-0 opacity-40 ml-0.5" />}
        {hasRemote && <Globe   size={8} className="shrink-0 opacity-40" />}
      </span>
    );
  }

  return (
    <BadgeMenu
      name={name} trackingName={trackingName}
      hasLocal={hasLocal} hasRemote={hasRemote}
      isHead={isHead} isTag={isTag}
      oid={oid} onAction={onAction}
    >
      {badge}
    </BadgeMenu>
  );
}
