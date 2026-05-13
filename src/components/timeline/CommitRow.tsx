import { formatDistanceToNow } from "date-fns";
import type { PositionedCommit } from "@/lib/ipc";
import { RefBadge, groupRefs } from "./RefBadge";
import { ROW_HEIGHT, REFS_COL_WIDTH } from "./GraphLayer";

interface Props {
  item: PositionedCommit;
  graphWidth: number;
  isSelected: boolean;
  isHead: boolean;
  headBranch: string | null;
  isStash?: boolean;
  onClick: () => void;
}

export function CommitRow({ item, graphWidth, isSelected, isHead, headBranch, isStash, onClick }: Props) {
  const { commit } = item;
  const relative = formatDistanceToNow(new Date(commit.timestamp * 1000), { addSuffix: true });
  const refGroups = groupRefs(commit.refs, headBranch);
  const MAX_REFS = 3;
  const visibleRefs = refGroups.slice(0, MAX_REFS);
  const hiddenCount = refGroups.length - MAX_REFS;
  const shortHash = commit.oid.slice(0, 7);

  const rowClass = [
    "flex items-center cursor-pointer select-none text-sm border-l-2 transition-colors duration-75",
    isStash ? "opacity-35 italic" : "",
    isHead && isSelected
      ? "border-l-teal-400 bg-teal-500/10"
      : isHead
      ? "border-l-teal-500/70 bg-teal-500/[0.04]"
      : isSelected
      ? "border-l-teal-400/50 bg-white/[0.07]"
      : "border-l-transparent hover:bg-white/[0.04]",
  ].join(" ");

  return (
    <div onClick={onClick} style={{ height: ROW_HEIGHT }} className={rowClass}>

      {/* Left: refs column */}
      <div
        style={{ width: REFS_COL_WIDTH, flexShrink: 0 }}
        className="flex items-center gap-0.5 px-2 overflow-hidden"
      >
        {visibleRefs.map((g) => (
          <RefBadge key={g.name} {...g} />
        ))}
        {hiddenCount > 0 && (
          <span className="text-[9px] font-mono text-muted-foreground/40 shrink-0 pl-0.5">+{hiddenCount}</span>
        )}
      </div>

      {/* Graph spacer */}
      <div style={{ width: graphWidth, flexShrink: 0 }} />

      {/* Message */}
      <span className={[
        "flex-1 min-w-0 truncate pl-2 text-[13px]",
        isHead ? "text-foreground/95" : "text-foreground/75",
        isStash ? "" : "",
      ].join(" ")}>
        {commit.summary}
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
}
