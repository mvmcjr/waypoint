import { formatDistanceToNow } from "date-fns";
import type { PositionedCommit } from "@/lib/ipc";
import { RefBadge } from "./RefBadge";
import { ROW_HEIGHT, LANE_WIDTH } from "./GraphLayer";

interface Props {
  item: PositionedCommit;
  graphWidth: number;
  isSelected: boolean;
  onClick: () => void;
}

export function CommitRow({ item, graphWidth, isSelected, onClick }: Props) {
  const { commit } = item;
  const date = new Date(commit.timestamp * 1000);
  const relative = formatDistanceToNow(date, { addSuffix: true });

  // The graph SVG sits to the left; we indent text to not overlap the dot.
  const dotX = item.lane * LANE_WIDTH + LANE_WIDTH / 2;
  const textIndent = Math.max(graphWidth, dotX + 20);

  return (
    <div
      onClick={onClick}
      style={{ height: ROW_HEIGHT, paddingLeft: textIndent }}
      className={`flex items-center gap-2 px-3 cursor-pointer select-none text-sm
        ${isSelected ? "bg-white/10" : "hover:bg-white/5"}`}
    >
      {/* Ref badges */}
      {commit.refs.length > 0 && (
        <span className="flex items-center shrink-0">
          {commit.refs.slice(0, 3).map((ref) => (
            <RefBadge key={ref} name={ref} />
          ))}
        </span>
      )}

      {/* Commit summary */}
      <span className="truncate text-foreground/90">{commit.summary}</span>

      {/* Spacer */}
      <span className="flex-1" />

      {/* Author */}
      <span className="text-muted-foreground text-xs shrink-0 hidden md:block">
        {commit.author_name}
      </span>

      {/* Relative time */}
      <span className="text-muted-foreground text-xs shrink-0 w-28 text-right">
        {relative}
      </span>
    </div>
  );
}
