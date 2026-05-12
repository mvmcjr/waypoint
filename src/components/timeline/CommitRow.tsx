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
  onClick: () => void;
}

export function CommitRow({ item, graphWidth, isSelected, isHead, headBranch, onClick }: Props) {
  const { commit } = item;
  const relative = formatDistanceToNow(new Date(commit.timestamp * 1000), { addSuffix: true });
  const refGroups = groupRefs(commit.refs, headBranch);

  const rowClass = [
    "flex items-center cursor-pointer select-none text-sm border-l-2",
    isHead ? "border-l-green-400" : "border-l-transparent",
    isHead && !isSelected ? "bg-green-500/5" : "",
    isSelected ? "bg-white/10" : "hover:bg-white/5",
  ].join(" ");

  return (
    <div onClick={onClick} style={{ height: ROW_HEIGHT }} className={rowClass}>

      {/* ── Left: refs column (fixed width, left of graph) ──────────── */}
      <div
        style={{ width: REFS_COL_WIDTH, flexShrink: 0 }}
        className="flex items-center gap-0.5 px-2 overflow-hidden"
      >
        {refGroups.slice(0, 3).map((g) => (
          <RefBadge key={g.name} {...g} />
        ))}
      </div>

      {/* ── Middle: transparent spacer for the graph SVG ────────────── */}
      <div style={{ width: graphWidth, flexShrink: 0 }} />

      {/* ── Right: commit message + metadata ────────────────────────── */}
      <span className="flex-1 min-w-0 truncate text-foreground/90 pl-2">
        {commit.summary}
      </span>

      <span className="text-muted-foreground text-xs shrink-0 hidden md:block px-3">
        {commit.author_name}
      </span>

      <span className="text-muted-foreground text-xs shrink-0 w-28 text-right pr-3">
        {relative}
      </span>
    </div>
  );
}
