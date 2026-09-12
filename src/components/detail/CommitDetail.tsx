import { useState, useRef, useEffect, useMemo } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { Copy, Check, Minus, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCommit, useCommitDiff, useCommitInRef } from "@/lib/queries";
import type { FileDiff, PositionedCommit } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { reflowCommitBody } from "@/lib/commitMessage";
import { CommitFileList } from "./CommitFileList";

/** Short hashes are 7 characters everywhere in the app. */
const short = (oid: string) => oid.slice(0, 7);

interface Props {
  repoId: string;
  item: PositionedCommit;
  /** Path of the file currently open in the diff panel, highlighted in the list. */
  selectedPath?: string | null;
  onFileClick?: (file: FileDiff) => void;
  /** Jump to another commit (parent chips). */
  onSelectCommit?: (oid: string) => void;
  /** Currently checked-out branch, or null when HEAD is detached. */
  headBranch?: string | null;
  /** Current HEAD commit oid, or null on an unborn repo. */
  headOid?: string | null;
}

/**
 * Small chip reporting whether this commit is in the history of the checked-out
 * branch (or HEAD, when detached). Renders nothing until an answer is in —
 * there's no useful "loading" state worth a layout jump for such a small badge.
 */
function InBranchBadge({
  repoId,
  oid,
  headBranch,
  headOid,
}: {
  repoId: string;
  oid: string;
  headBranch: string | null;
  headOid: string | null;
}) {
  const { data: inRef, error } = useCommitInRef(repoId, oid, null, headOid);

  if (!headOid || error || inRef === undefined) return null;

  const label = headBranch ?? "HEAD";
  // `truncate` (text-overflow: ellipsis) has no effect on a flex container's
  // children as a whole — it only works on the element whose own content
  // overflows. So the chip clips via overflow-hidden + min-w-0, the icon and
  // "in"/"not in" word stay shrink-0, and only the branch-name span truncates.
  const base = "inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] max-w-[9rem] min-w-0 overflow-hidden";

  if (inRef) {
    return (
      <span
        className={`${base} bg-white/[0.06] text-foreground/80`}
        title={label}
        aria-label={`This commit is in ${label}`}
      >
        <Check size={11} className="shrink-0" aria-hidden />
        <span className="shrink-0">in</span>{" "}
        <span className="font-mono truncate min-w-0">{label}</span>
      </span>
    );
  }

  return (
    <span
      className={`${base} text-muted-foreground border border-dashed border-foreground/15`}
      title={label}
      aria-label={`This commit is not in ${label}`}
    >
      <Minus size={11} className="shrink-0" aria-hidden />
      <span className="shrink-0">not in</span>{" "}
      <span className="font-mono truncate min-w-0">{label}</span>
    </span>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-muted-foreground/80">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

export function CommitDetail({
  repoId,
  item,
  selectedPath = null,
  onFileClick,
  onSelectCommit,
  headBranch = null,
  headOid = null,
}: Props) {
  const { commit } = item;
  const { data: diff, isLoading, error, refetch, isFetching } = useCommitDiff(repoId, commit.oid);
  // The list payload omits the body to stay lean for large repos; fetch it lazily.
  const { data: full } = useCommit(repoId, commit.oid);
  const body = full?.body ?? commit.body;
  const reflowed = useMemo(() => (body ? reflowCommitBody(body) : ""), [body]);

  const collapsed = useStore((s) => s.commitPanelCollapsed);
  const setViewPref = useStore((s) => s.setViewPref);

  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Clear the reset-timer if the component unmounts before it fires.
  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  // A new commit starts at the top of the panel.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [commit.oid]);

  const date = new Date(commit.timestamp * 1000);
  const isMerge = commit.parent_oids.length > 1;

  async function copyHash() {
    try {
      await navigator.clipboard.writeText(commit.oid);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — no UI change.
    }
  }

  if (collapsed) {
    return (
      <aside className="w-8 shrink-0 border-l border-border flex flex-col bg-card items-center pt-2 overflow-hidden">
        <button
          type="button"
          onClick={() => setViewPref("commitPanelCollapsed", false)}
          className="p-1 rounded-md hover:bg-white/[0.07] text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Expand commit details"
          title="Expand commit details"
        >
          <ChevronLeft size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-80 shrink-0 border-l border-border flex flex-col bg-card overflow-hidden" aria-label="Commit details">
      {/* Header */}
      <div className="shrink-0 h-9 px-3 border-b border-border flex items-center gap-2">
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.12em]">Commit</h2>
        <button
          type="button"
          onClick={copyHash}
          title={`Copy full hash ${commit.oid}`}
          aria-label={copied ? "Hash copied" : `Copy full hash ${commit.oid}`}
          className="group flex items-center gap-1 rounded px-1 -mx-0.5 font-mono text-[11px] text-foreground/70 hover:text-foreground hover:bg-white/[0.07] transition-colors"
        >
          {short(commit.oid)}
          {copied
            ? <Check className="size-3 shrink-0 text-foreground" aria-hidden />
            : <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60 transition-opacity" aria-hidden />}
        </button>
        <span className="sr-only" aria-live="polite">{copied ? "Hash copied to clipboard" : ""}</span>
        <InBranchBadge repoId={repoId} oid={commit.oid} headBranch={headBranch} headOid={headOid} />
        <button
          type="button"
          onClick={() => setViewPref("commitPanelCollapsed", true)}
          className="ml-auto p-0.5 rounded-md hover:bg-white/[0.07] text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Collapse commit details"
          title="Collapse commit details"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* One scroll for message, metadata, and files — no nested scroll boxes. */}
      <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-y-auto">
        <div className="px-3 pt-3 pb-3 space-y-3">
          <div className="space-y-2">
            <p className="text-[13px] font-medium text-foreground leading-snug break-words">{commit.summary}</p>
            {reflowed && (
              <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
                {reflowed}
              </p>
            )}
          </div>

          <dl className="space-y-1.5 text-xs text-foreground/80">
            <MetaRow label="Author">
              <div className="truncate">{commit.author_name}</div>
              <div className="truncate text-[11px] text-muted-foreground" title={commit.author_email}>
                {commit.author_email}
              </div>
            </MetaRow>
            <MetaRow label="Date">
              <span className="tabular-nums" title={format(date, "PPpp")}>
                {format(date, "PP, p")}
              </span>
              <span className="text-muted-foreground"> · {formatDistanceToNowStrict(date, { addSuffix: true })}</span>
            </MetaRow>
            <MetaRow label={commit.parent_oids.length > 1 ? "Parents" : "Parent"}>
              {commit.parent_oids.length === 0 ? (
                <span className="text-muted-foreground">None — root commit</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {commit.parent_oids.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => onSelectCommit?.(p)}
                      disabled={!onSelectCommit}
                      title={`Go to parent ${p}`}
                      aria-label={`Go to parent commit ${short(p)}`}
                      className="rounded px-1 -mx-0.5 font-mono text-[11px] text-foreground/70 hover:text-foreground hover:bg-white/[0.07] transition-colors disabled:pointer-events-none"
                    >
                      {short(p)}
                    </button>
                  ))}
                </span>
              )}
            </MetaRow>
          </dl>
        </div>

        {isLoading ? (
          <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground">Loading changes…</p>
        ) : error ? (
          <div className="border-t border-border px-3 py-3 space-y-2" role="alert">
            <p className="text-xs text-foreground/80">Couldn't load this commit's changes.</p>
            <p className="text-[11px] text-muted-foreground break-words">{String(error)}</p>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-1 rounded-md border border-input bg-white/[0.033] px-2 h-6 text-xs text-foreground hover:bg-white/[0.055] active:translate-y-px disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={11} className={isFetching ? "animate-spin" : ""} aria-hidden />
              Retry
            </button>
          </div>
        ) : diff && diff.length === 0 ? (
          <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground">
            {commit.parent_oids.length === 0 ? "This commit adds no files." : "No file changes — an empty commit."}
          </p>
        ) : diff ? (
          <CommitFileList
            files={diff}
            scrollRef={scrollRef}
            selectedPath={selectedPath}
            onFileClick={onFileClick}
            note={isMerge ? (
              <p className="px-3 pt-2 text-[11px] text-muted-foreground">
                Merge commit — changes shown against the first parent,{" "}
                <span className="font-mono">{short(commit.parent_oids[0])}</span>.
              </p>
            ) : undefined}
          />
        ) : null}
      </div>
    </aside>
  );
}
