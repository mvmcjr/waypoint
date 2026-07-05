import { memo } from "react";
import { formatDistanceToNow } from "date-fns";
import type { PositionedCommit } from "@/lib/ipc";
import { Archive } from "lucide-react";
import { RefBadge, groupRefs, type RefAction } from "./RefBadge";
import { ROW_HEIGHT } from "./GraphLayer";
import type { CommitAction } from "./CommitContextMenu";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { stashLabel } from "@/lib/utils";

interface Props {
  item: PositionedCommit;
  refsWidth: number;
  graphWidth: number;
  isSelected: boolean;
  /** True while this row's context menu is open — keeps the row highlighted so it's clear what the menu applies to. */
  isContextTarget?: boolean;
  isHead: boolean;
  headBranch: string | null;
  pushedTagNames?: Set<string>;
  isStash?: boolean;
  /** For stash rows: the reflog-derived name (reflects renames; commit.summary does not). */
  stashName?: string;
  onRefAction?: (action: RefAction) => void;
  onCommitAction?: (action: CommitAction) => void;
  onSelect: (oid: string, mods: { ctrl: boolean; shift: boolean }) => void;
}

export const CommitRow = memo(function CommitRow({ item, refsWidth, graphWidth, isSelected, isContextTarget, isHead, headBranch, pushedTagNames, isStash, stashName, onRefAction, onCommitAction, onSelect }: Props) {
  const { commit } = item;
  const relative = formatDistanceToNow(new Date(commit.timestamp * 1000), { addSuffix: true });
  const refGroups = groupRefs(commit.refs, item.commit.local_branches, item.commit.remote_branches, headBranch, pushedTagNames);
  const MAX_REFS = 3;
  const visibleRefs = refGroups.slice(0, MAX_REFS);
  const hiddenCount = refGroups.length - MAX_REFS;
  const shortHash = commit.oid.slice(0, 7);
  const highlighted = isSelected || isContextTarget;

  const rowClass = [
    "flex items-center cursor-pointer select-none text-sm border-l-2 transition-colors duration-75",
    isStash ? "opacity-35 italic" : "",
    isHead && highlighted
      ? "border-l-teal-400 bg-teal-500/10"
      : isHead
      ? "border-l-teal-500/70 bg-teal-500/[0.04]"
      : highlighted
      ? "border-l-teal-400/50 bg-white/[0.07]"
      : "border-l-transparent hover:bg-white/[0.04]",
  ].join(" ");

  return (
    <div
      onClick={(e) => onSelect(commit.oid, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      style={{ height: ROW_HEIGHT }}
      className={rowClass}
    >

      {/* Left: refs column */}
      <div
        style={{ width: refsWidth, flexShrink: 0 }}
        className="flex items-center gap-0.5 px-2 overflow-hidden"
      >
        {isStash ? (
          // Plain (menu-less) badge so the row's StashContextMenu handles right-click.
          <span className="inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-mono bg-amber-500/12 text-amber-300/85 border border-amber-500/20 shrink-0">
            <Archive size={9} className="opacity-70" />
            stash
          </span>
        ) : (
          <>
        {visibleRefs.map((g) => (
          <RefBadge key={g.name} {...g} oid={commit.oid} onAction={onRefAction} onCommitAction={onCommitAction} commitSummary={commit.summary} />
        ))}
        {hiddenCount > 0 && (
          <HoverCard>
            <HoverCardTrigger
              render={
                <span
                  className="text-[9px] font-mono text-muted-foreground/50 shrink-0 pl-0.5 cursor-default rounded px-1 hover:bg-white/10 hover:text-foreground/80 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                />
              }
            >
              +{hiddenCount}
            </HoverCardTrigger>
            <HoverCardContent
              align="start"
              className="w-auto max-w-sm max-h-64 overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex flex-wrap gap-1">
                {refGroups.map((g) => (
                  <RefBadge
                    key={g.name}
                    {...g}
                    oid={commit.oid}
                    onAction={onRefAction}
                    onCommitAction={onCommitAction}
                    commitSummary={commit.summary}
                  />
                ))}
              </div>
            </HoverCardContent>
          </HoverCard>
        )}
          </>
        )}
      </div>

      {/* Graph spacer */}
      <div style={{ width: graphWidth, flexShrink: 0 }} />

      {/* Message */}
      <span className={[
        "flex-1 min-w-0 truncate pl-2 text-[13px]",
        isHead ? "text-foreground/95" : "text-foreground/75",
      ].join(" ")}>
        {isStash ? (stashName ?? stashLabel(commit.summary)) : commit.summary}
      </span>

      {/* Right metadata cluster */}
      <div className="shrink-0 flex items-center gap-2.5 pr-3">
        <span className="text-muted-foreground/50 text-[11px] shrink-0 hidden md:block max-w-[88px] truncate">
          {commit.author_name}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/30 shrink-0 hidden lg:block tracking-tight">
          {shortHash}
        </span>
        <span className="text-muted-foreground/60 text-[11px] shrink-0 w-[90px] text-right tabular-nums">
          {relative}
        </span>
      </div>
    </div>
  );
});
