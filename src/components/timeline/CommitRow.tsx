import { memo } from "react";
import { formatDistanceToNow } from "date-fns";
import type { PositionedCommit } from "@/lib/ipc";
import { Archive } from "lucide-react";
import { RefBadge, groupRefs, type RefAction } from "./RefBadge";
import { ROW_HEIGHT } from "./GraphLayer";
import type { CommitAction } from "./CommitContextMenu";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { stashLabel } from "@/lib/utils";
import { splitHighlights } from "@/lib/commitSearch";

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
  /** True while a "go to commit" find is active and this row is NOT a match — dims it. */
  isDimmed?: boolean;
  /** Query tokens to highlight in this row (only passed for matching rows — keeps memo effective on the rest). */
  highlightTokens?: string[];
  /** Local branch shorthand -> the other worktree's path it's checked out in (see RefInfo.worktree_path). */
  worktreeByBranch?: Map<string, string>;
  onRefAction?: (action: RefAction) => void;
  onCommitAction?: (action: CommitAction) => void;
  onSelect: (oid: string, mods: { ctrl: boolean; shift: boolean }) => void;
}

/** Renders text with <mark> runs around each matched token (see splitHighlights). */
function Highlighted({ text, tokens }: { text: string; tokens?: string[] }) {
  if (!tokens || tokens.length === 0) return <>{text}</>;
  return (
    <>
      {splitHighlights(text, tokens).map((seg, i) =>
        seg.match ? (
          <mark key={i} className="bg-white/[0.14] text-foreground rounded-[2px]">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

// Oids only match by prefix, and only for tokens >=4 chars (see commitSearch's
// MIN_OID_TOKEN_LEN) — highlighting the short hash must follow the same rule,
// not generic substring matching, or e.g. "de" would light up mid-hash on
// commits that never actually matched by oid.
function HighlightedHash({ oid, shortHash, tokens }: { oid: string; shortHash: string; tokens?: string[] }) {
  if (!tokens || tokens.length === 0) return <>{shortHash}</>;
  const oidLower = oid.toLowerCase();
  let len = 0;
  for (const tok of tokens) {
    if (tok.length >= 4 && oidLower.startsWith(tok)) len = Math.max(len, Math.min(tok.length, shortHash.length));
  }
  if (len === 0) return <>{shortHash}</>;
  return (
    <>
      <mark className="bg-white/[0.14] text-foreground rounded-[2px]">{shortHash.slice(0, len)}</mark>
      {shortHash.slice(len)}
    </>
  );
}

export const CommitRow = memo(function CommitRow({ item, refsWidth, graphWidth, isSelected, isContextTarget, isHead, headBranch, pushedTagNames, isStash, stashName, isDimmed, highlightTokens, worktreeByBranch, onRefAction, onCommitAction, onSelect }: Props) {
  const { commit } = item;
  const relative = formatDistanceToNow(new Date(commit.timestamp * 1000), { addSuffix: true });
  const refGroups = groupRefs(commit.refs, item.commit.local_branches, item.commit.remote_branches, headBranch, pushedTagNames);
  const MAX_REFS = 3;
  const visibleRefs = refGroups.slice(0, MAX_REFS);
  const hiddenCount = refGroups.length - MAX_REFS;
  const shortHash = commit.oid.slice(0, 7);
  // Badge width budget scales with the (resizable) refs column instead of a fixed
  // cap, so widening it actually shows more of the name rather than always
  // truncating at the same point. Reserves column padding, inter-badge gaps, and
  // the "+N" overflow indicator's own width.
  const badgeMaxWidth = visibleRefs.length > 0
    ? Math.max(50, Math.floor(
        (refsWidth - 16 - 2 * Math.max(visibleRefs.length - 1, 0) - (hiddenCount > 0 ? 20 : 0))
        / visibleRefs.length
      ))
    : undefined;
  const highlighted = isSelected || isContextTarget;
  // Non-empty highlightTokens is exactly how Timeline signals "this row matches
  // the active find" (see NO_HIGHLIGHTS) — reuse that instead of a new prop.
  const isMatchingRow = !!highlightTokens && highlightTokens.length > 0;

  const rowClass = [
    "flex items-center cursor-pointer select-none text-sm border-l-2 transition-colors duration-75",
    // A dimmed (non-matching) stash row stays at its own (lower) opacity rather
    // than stacking with opacity-40; a *matching* stash row brightens instead,
    // so it doesn't read the same as a non-match.
    isStash ? (isMatchingRow ? "opacity-60 italic" : "opacity-35 italic") : isDimmed ? "opacity-40" : "",
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
      data-testid="commit-row"
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
          <RefBadge key={g.name} {...g} oid={commit.oid} onAction={onRefAction} onCommitAction={onCommitAction} commitSummary={commit.summary} maxWidth={badgeMaxWidth} worktreePath={!g.isTag ? worktreeByBranch?.get(g.name) : undefined} />
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
                    maxWidth={200}
                    worktreePath={!g.isTag ? worktreeByBranch?.get(g.name) : undefined}
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
        <Highlighted text={isStash ? (stashName ?? stashLabel(commit.summary)) : commit.summary} tokens={highlightTokens} />
      </span>

      {/* Right metadata cluster */}
      <div className="shrink-0 flex items-center gap-2.5 pr-3">
        <span className="text-muted-foreground/50 text-[11px] shrink-0 hidden md:block max-w-[88px] truncate">
          <Highlighted text={commit.author_name} tokens={highlightTokens} />
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/30 shrink-0 hidden lg:block tracking-tight">
          <HighlightedHash oid={commit.oid} shortHash={shortHash} tokens={highlightTokens} />
        </span>
        <span className="text-muted-foreground/60 text-[11px] shrink-0 w-[90px] text-right tabular-nums">
          {relative}
        </span>
      </div>
    </div>
  );
});
