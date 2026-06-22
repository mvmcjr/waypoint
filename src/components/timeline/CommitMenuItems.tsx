import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { usePluginRegistry, commandsForSurface } from "@/lib/plugins/registry";
import { usePluginRunner } from "@/components/plugins/PluginRunnerProvider";
import type { PluginContext, Surface } from "@/lib/plugins/types";

// Defined here (not in CommitContextMenu) so both CommitContextMenu and
// BadgeMenu can import the type without a circular dependency.
export type CommitAction =
  | { kind: "checkout-detached"; oid: string }
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "checkout-remote-branch"; remoteBranch: string }
  | { kind: "create-branch"; oid: string }
  | { kind: "create-tag"; oid: string }
  | { kind: "reset"; oid: string }
  | { kind: "rebase"; oid: string }
  | { kind: "squash"; oids: string[] }
  | { kind: "merge"; oid: string; label: string }
  | { kind: "cherry-pick"; oid: string; summary: string }
  | { kind: "revert"; oid: string; summary: string };

export interface CommitMenuItemsProps {
  oid: string;
  isHead: boolean;
  /** Label used in "Merge into current branch" — caller provides the most specific name. */
  mergeLabel: string;
  /** Commit message for cherry-pick. Pass undefined to suppress the cherry-pick item. */
  commitSummary: string | undefined;
  onAction: (action: CommitAction) => void;
  /** Extra copy items inserted after "Copy full hash" (before the section separator). */
  extraCopyItems?: React.ReactNode;
  /** Checkout affordances injected after the separator that follows the copy section. */
  checkoutSlot?: React.ReactNode;
  /** Pass true to hide "New tag here…" — e.g. on tag badges. */
  hideCreateTag?: boolean;
  /** Pass true to hide Merge / Cherry-pick / Rebase — e.g. on tag badges. */
  hideMergeRebase?: boolean;
  /** Pass true to hide "Reset HEAD here…" — e.g. on HEAD badges where reset is a no-op. */
  hideReset?: boolean;
  /** Active multi-selection. When this oid is part of a ≥2 selection, a "Squash N commits…" item appears. */
  selectedOids?: string[];
  /** When set, plugin commands for the given surface are appended to the menu. */
  pluginContext?: { surface: Surface; extra: Partial<PluginContext> };
}

export function CommitMenuItems({
  oid, isHead, mergeLabel, commitSummary, onAction,
  extraCopyItems, checkoutSlot, hideCreateTag, hideMergeRebase, hideReset, selectedOids,
  pluginContext,
}: CommitMenuItemsProps) {
  const short = oid.slice(0, 8);
  const runner = usePluginRunner();
  const plugins = usePluginRegistry((s) => s.plugins);
  const pluginCmds = pluginContext
    ? commandsForSurface(plugins, pluginContext.surface)
    : [];
  // Offer squash only when right-clicking inside a multi-selection of 2+ commits.
  const squashOids = selectedOids && selectedOids.length >= 2 && selectedOids.includes(oid)
    ? selectedOids
    : null;

  return (
    <>
      {/* ── Copy ──────────────────────────────────────────────── */}
      <ContextMenuItem onClick={() => navigator.clipboard.writeText(short)}>
        Copy short hash{" "}
        <span className="ml-auto font-mono text-xs text-muted-foreground">{short}</span>
      </ContextMenuItem>
      <ContextMenuItem onClick={() => navigator.clipboard.writeText(oid)}>
        Copy full hash
      </ContextMenuItem>
      {extraCopyItems}

      <ContextMenuSeparator />

      {/* ── Checkout (caller-injected) ─────────────────────────── */}
      {checkoutSlot}

      {/* ── Create ────────────────────────────────────────────── */}
      <ContextMenuItem onClick={() => onAction({ kind: "create-branch", oid })}>
        New branch here…
      </ContextMenuItem>
      {!hideCreateTag && (
        <ContextMenuItem onClick={() => onAction({ kind: "create-tag", oid })}>
          New tag here…
        </ContextMenuItem>
      )}

      {/* ── Merge / cherry-pick / rebase / revert ──────── */}
      {!hideMergeRebase && (
        <>
          {(!isHead || commitSummary !== undefined) && <ContextMenuSeparator />}
          {!isHead && (
            <ContextMenuItem onClick={() => onAction({ kind: "merge", oid, label: mergeLabel })}>
              Merge into current branch
            </ContextMenuItem>
          )}
          {!isHead && commitSummary !== undefined && (
            <ContextMenuItem
              onClick={() => onAction({ kind: "cherry-pick", oid, summary: commitSummary })}
            >
              Cherry-pick onto current branch
            </ContextMenuItem>
          )}
          {commitSummary !== undefined && (
            <ContextMenuItem
              onClick={() => onAction({ kind: "revert", oid, summary: commitSummary })}
            >
              Revert commit…
            </ContextMenuItem>
          )}
          {!isHead && (
            <ContextMenuItem onClick={() => onAction({ kind: "rebase", oid })}>
              Rebase current branch here
            </ContextMenuItem>
          )}
        </>
      )}

      {/* ── Squash selected (multi-selection of 2+) ───────────── */}
      {!hideMergeRebase && squashOids && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onAction({ kind: "squash", oids: squashOids })}>
            Squash {squashOids.length} commits…
          </ContextMenuItem>
        </>
      )}

      {/* ── Plugin commands ───────────────────────────────────── */}
      {pluginContext && pluginCmds.length > 0 && (
        <>
          <ContextMenuSeparator />
          {pluginCmds.map(({ pluginId, command }) => (
            <ContextMenuItem
              key={`${pluginId}:${command.id}`}
              onClick={() => runner.run(pluginId, command, pluginContext.surface, pluginContext.extra)}
            >
              {command.title}
            </ContextMenuItem>
          ))}
        </>
      )}

      {/* ── Destructive ────────────────────────────────────────── */}
      {!hideReset && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => onAction({ kind: "reset", oid })}
            className="text-destructive focus:text-destructive"
          >
            Reset HEAD here…
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
