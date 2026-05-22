import { useState, useEffect, useRef, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { ipc } from "@/lib/ipc";

// ── Types ─────────────────────────────────────────────────────────────────────

type Segment =
  | { kind: "context"; lines: string[] }
  | { kind: "conflict"; idx: number; oursLabel: string; ours: string[]; theirs: string[]; theirsLabel: string };

type ConflictSeg = Extract<Segment, { kind: "conflict" }>;

/**
 * How a single conflict hunk is resolved:
 *  - "ours"   → all lines from our side
 *  - "theirs" → all lines from their side
 *  - "both"   → all ours then all theirs
 *  - "custom" → individually toggled lines from either side
 */
type HunkResolution =
  | { mode: "ours" | "theirs" | "both" }
  | { mode: "custom"; oursLines: Set<number>; theirsLines: Set<number>; approved: boolean };

function isFinalized(res: HunkResolution | undefined): boolean {
  if (!res) return false;
  if (res.mode === "custom") return res.approved;
  return true;
}

export type ViewMode = "stacked" | "side-by-side";

// ── Parser ────────────────────────────────────────────────────────────────────

function parseConflictFile(content: string): Segment[] {
  const lines = content.split("\n");
  const segments: Segment[] = [];
  let contextBuf: string[] = [];
  let idx = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("<<<<<<<")) {
      if (contextBuf.length > 0) { segments.push({ kind: "context", lines: contextBuf }); contextBuf = []; }
      const oursLabel = line.slice(7).trim();
      const ours: string[] = [];
      const theirs: string[] = [];
      let theirsLabel = "";
      let state: "ours" | "base" | "theirs" = "ours";
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith(">>>>>>>")) { theirsLabel = l.slice(7).trim(); i++; break; }
        else if (l.startsWith("=======")) { state = "theirs"; }
        else if (l.startsWith("|||||||")) { state = "base"; } // diff3 — skip base
        else if (state === "ours")   { ours.push(l); }
        else if (state === "theirs") { theirs.push(l); }
        i++;
      }
      segments.push({ kind: "conflict", idx: idx++, oursLabel, ours, theirs, theirsLabel });
    } else { contextBuf.push(line); i++; }
  }
  if (contextBuf.length > 0) segments.push({ kind: "context", lines: contextBuf });
  return segments;
}

// ── Resolution helpers ────────────────────────────────────────────────────────

function isIncluded(res: HunkResolution | undefined, side: "ours" | "theirs", lineIdx: number): boolean {
  if (!res) return false;
  if (res.mode === "ours")   return side === "ours";
  if (res.mode === "theirs") return side === "theirs";
  if (res.mode === "both")   return true;
  if (res.mode === "custom") {
    return side === "ours" ? res.oursLines.has(lineIdx) : res.theirsLines.has(lineIdx);
  }
  return false;
}

function getResolvedLines(seg: ConflictSeg, res: HunkResolution | undefined): string[] | null {
  if (!res) return null;
  if (res.mode === "ours")   return [...seg.ours];
  if (res.mode === "theirs") return [...seg.theirs];
  if (res.mode === "both")   return [...seg.ours, ...seg.theirs];
  if (res.mode === "custom") {
    return [
      ...seg.ours.filter((_, i) => res.oursLines.has(i)),
      ...seg.theirs.filter((_, i) => res.theirsLines.has(i)),
    ];
  }
  return null;
}

function buildResolved(segments: Segment[], resolutions: Map<number, HunkResolution>): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "context") {
      parts.push(seg.lines.join("\n"));
    } else {
      const lines = getResolvedLines(seg, resolutions.get(seg.idx));
      if (lines !== null) parts.push(lines.join("\n"));
    }
  }
  return parts.filter((p) => p !== "").join("\n");
}

/** Set whole-hunk mode, clearing any custom line selection. */
function withModeSet(
  prev: Map<number, HunkResolution>,
  idx: number,
  mode: "ours" | "theirs" | "both",
): Map<number, HunkResolution> {
  return new Map(prev).set(idx, { mode });
}

/**
 * Toggle a single line. If the hunk had a whole-hunk mode, convert it to
 * "custom" starting from that effective selection, then toggle the clicked line.
 * If no resolution existed yet, start from an empty custom selection.
 */
function withLineToggled(
  prev: Map<number, HunkResolution>,
  seg: ConflictSeg,
  side: "ours" | "theirs",
  lineIdx: number,
): Map<number, HunkResolution> {
  const next = new Map(prev);
  const cur  = prev.get(seg.idx);

  let oursLines: Set<number>;
  let theirsLines: Set<number>;

  if (!cur) {
    oursLines   = new Set();
    theirsLines = new Set();
  } else if (cur.mode === "custom") {
    oursLines   = new Set(cur.oursLines);
    theirsLines = new Set(cur.theirsLines);
  } else if (cur.mode === "ours") {
    oursLines   = new Set(seg.ours.map((_, i) => i));
    theirsLines = new Set();
  } else if (cur.mode === "theirs") {
    oursLines   = new Set();
    theirsLines = new Set(seg.theirs.map((_, i) => i));
  } else { // "both"
    oursLines   = new Set(seg.ours.map((_, i) => i));
    theirsLines = new Set(seg.theirs.map((_, i) => i));
  }

  const set = side === "ours" ? oursLines : theirsLines;
  if (set.has(lineIdx)) set.delete(lineIdx);
  else                  set.add(lineIdx);

  next.set(seg.idx, { mode: "custom", oursLines, theirsLines, approved: false });
  return next;
}

// ── Shared UI primitives ──────────────────────────────────────────────────────

function ChoiceButton({
  active, tint, label, onClick,
}: {
  active: boolean; tint: "blue" | "purple" | "teal"; label: string; onClick: () => void;
}) {
  const base = "shrink-0 text-[10px] px-2 py-0.5 rounded-full border transition-colors font-medium";
  const styles: Record<string, string> = {
    blue:   active ? "bg-blue-500/30 text-blue-200 border-blue-400/60"       : "text-blue-300/55 border-blue-400/25 hover:text-blue-200 hover:bg-blue-500/20",
    purple: active ? "bg-purple-500/30 text-purple-200 border-purple-400/60" : "text-purple-300/55 border-purple-400/25 hover:text-purple-200 hover:bg-purple-500/20",
    teal:   active ? "bg-teal-500/25 text-teal-200 border-teal-400/50"       : "text-muted-foreground/45 border-border/40 hover:text-teal-200 hover:bg-teal-500/15",
  };
  return (
    <button className={`${base} ${styles[tint]}`} onClick={onClick}>
      {active ? `✓ ${label}` : label}
    </button>
  );
}

/** A single toggleable code line. ○ = excluded (dimmed), ● = included. */
function ToggleableLine({
  text, lineNo, included, tint, onToggle,
}: {
  text: string; lineNo: number; included: boolean;
  tint: "blue" | "purple"; onToggle: () => void;
}) {
  const activeBg   = tint === "blue" ? "bg-blue-500/20"   : "bg-purple-500/20";
  const dotColor   = tint === "blue" ? "text-blue-400"    : "text-purple-400";
  const textActive = tint === "blue" ? "text-blue-100/85" : "text-purple-100/85";

  return (
    <button
      onClick={onToggle}
      title={included ? "Click to exclude this line" : "Click to include this line"}
      className={`w-full flex items-start text-left transition-colors ${
        included ? activeBg : "opacity-35 hover:opacity-65"
      } hover:brightness-125`}
    >
      {/* ● / ○ indicator */}
      <span className={`w-5 shrink-0 text-center text-[9px] leading-[1.7*11px] pt-[3px] select-none ${included ? dotColor : "text-muted-foreground/20"}`}>
        {included ? "●" : "○"}
      </span>
      {/* Line number */}
      <span className="w-7 shrink-0 text-right pr-2 font-mono text-[10px] leading-[1.7] text-muted-foreground/30 select-none border-r border-white/5">
        {lineNo + 1}
      </span>
      {/* Content — overflow-hidden so long lines don't expand the column */}
      <span className={`pl-2 font-mono text-[11px] leading-[1.7] whitespace-pre overflow-hidden min-w-0 flex-1 ${included ? textActive : "text-muted-foreground/45"}`}>
        {text || "\u200b"}
      </span>
    </button>
  );
}

/** Read-only code line for the Result column / preview. */
function ResultLine({ text, lineNo }: { text: string; lineNo: number }) {
  return (
    <div className="flex items-start bg-teal-500/[0.07]">
      <span className="w-7 shrink-0 text-right pr-2 font-mono text-[10px] leading-[1.7] text-muted-foreground/25 select-none border-r border-white/5">
        {lineNo + 1}
      </span>
      <span className="pl-2 font-mono text-[11px] leading-[1.7] whitespace-pre overflow-hidden text-teal-100/80">
        {text || "\u200b"}
      </span>
    </div>
  );
}

// ── Hunk: stacked ─────────────────────────────────────────────────────────────

function StackedHunk({
  seg, num, total, resolution, onSetMode, onToggleLine, onApproveCustom,
}: {
  seg: ConflictSeg; num: number; total: number;
  resolution: HunkResolution | undefined;
  onSetMode: (mode: "ours" | "theirs" | "both") => void;
  onToggleLine: (side: "ours" | "theirs", idx: number) => void;
  onApproveCustom: () => void;
}) {
  const resolvedLines = getResolvedLines(seg, resolution);

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden mb-4">
      {/* Badge row */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.03] border-b border-border/40">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Conflict {num} of {total}
        </span>
        {isFinalized(resolution) && (
          <span className="text-[10px] text-green-400/80 font-medium">✓ resolved</span>
        )}
      </div>

      {/* Ours section */}
      <div className="border-l-[3px] border-blue-400/60">
        <div className="flex items-center justify-between px-3 py-1 border-b border-border/20 bg-blue-500/[0.04]">
          <span className="text-[10px] font-mono text-blue-300/70 truncate min-w-0 mr-2">
            ← {seg.oursLabel || "HEAD"}
          </span>
          <ChoiceButton active={resolution?.mode === "ours"} tint="blue" label="Ours" onClick={() => onSetMode("ours")} />
        </div>
        {seg.ours.length > 0
          ? seg.ours.map((line, i) => (
              <ToggleableLine key={i} text={line} lineNo={i} tint="blue"
                included={isIncluded(resolution, "ours", i)}
                onToggle={() => onToggleLine("ours", i)}
              />
            ))
          : <div className="px-4 py-2 text-[10px] italic text-muted-foreground/35">(empty — this side deletes these lines)</div>
        }
      </div>

      <div className="h-px bg-border/40" />

      {/* Theirs section */}
      <div className="border-l-[3px] border-purple-400/60">
        <div className="flex items-center justify-between px-3 py-1 border-b border-border/20 bg-purple-500/[0.04]">
          <span className="text-[10px] font-mono text-purple-300/70 truncate min-w-0 mr-2">
            → {seg.theirsLabel || "theirs"}
          </span>
          <div className="flex gap-1.5 shrink-0">
            <ChoiceButton active={resolution?.mode === "both"} tint="teal" label="Both" onClick={() => onSetMode("both")} />
            <ChoiceButton active={resolution?.mode === "theirs"} tint="purple" label="Theirs" onClick={() => onSetMode("theirs")} />
          </div>
        </div>
        {seg.theirs.length > 0
          ? seg.theirs.map((line, i) => (
              <ToggleableLine key={i} text={line} lineNo={i} tint="purple"
                included={isIncluded(resolution, "theirs", i)}
                onToggle={() => onToggleLine("theirs", i)}
              />
            ))
          : <div className="px-4 py-2 text-[10px] italic text-muted-foreground/35">(empty — this side deletes these lines)</div>
        }
      </div>

      {/* Per-hunk result — only shown once a choice has been made */}
      {resolvedLines !== null && (
        <div className="border-t border-border/40 bg-teal-950/25">
          <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-teal-400/50 font-semibold border-b border-border/20 flex justify-between items-center">
            <span>Result</span>
            {resolution?.mode === "custom" && (
              resolution.approved ? (
                <span className="text-[10px] text-teal-300 font-medium flex items-center gap-1 normal-case font-normal select-none">
                  ✓ Accepted
                </span>
              ) : (
                <button
                  onClick={onApproveCustom}
                  className="text-[9px] px-2 py-0.5 rounded bg-teal-500/20 text-teal-200 border border-teal-500/35 hover:bg-teal-500/30 transition-colors normal-case font-medium cursor-pointer"
                >
                  Accept Custom Selection
                </button>
              )
            )}
          </div>
          {resolvedLines.length > 0
            ? resolvedLines.map((line, i) => <ResultLine key={i} text={line} lineNo={i} />)
            : <div className="px-4 py-2 text-[10px] italic text-muted-foreground/35">(empty — section will be deleted)</div>
          }
        </div>
      )}
    </div>
  );
}

// ── Hunk: side-by-side (3 columns: Ours | Theirs | Result) ───────────────────

function SideBySideHunk({
  seg, num, total, resolution, onSetMode, onToggleLine, onApproveCustom,
}: {
  seg: ConflictSeg; num: number; total: number;
  resolution: HunkResolution | undefined;
  onSetMode: (mode: "ours" | "theirs" | "both") => void;
  onToggleLine: (side: "ours" | "theirs", idx: number) => void;
  onApproveCustom: () => void;
}) {
  const resolvedLines = getResolvedLines(seg, resolution);

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden mb-4">
      {/* Badge row */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.03] border-b border-border/40">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Conflict {num} of {total}
        </span>
        {isFinalized(resolution) && (
          <span className="text-[10px] text-green-400/80 font-medium">✓ resolved</span>
        )}
      </div>

      {/* Three equal columns */}
      <div className="grid grid-cols-3 divide-x divide-border/40">

        {/* Ours */}
        <div className="border-l-[3px] border-blue-400/60 min-w-0 overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 border-b border-border/20 bg-blue-500/[0.04]">
            <span className="text-[10px] font-mono text-blue-300/70 truncate min-w-0 mr-1">
              ← {seg.oursLabel || "HEAD"}
            </span>
            <ChoiceButton active={resolution?.mode === "ours"} tint="blue" label="Ours" onClick={() => onSetMode("ours")} />
          </div>
          {seg.ours.length > 0
            ? seg.ours.map((line, i) => (
                <ToggleableLine key={i} text={line} lineNo={i} tint="blue"
                  included={isIncluded(resolution, "ours", i)}
                  onToggle={() => onToggleLine("ours", i)}
                />
              ))
            : <div className="px-3 py-3 text-[10px] italic text-muted-foreground/35">(empty)</div>
          }
        </div>

        {/* Theirs */}
        <div className="border-l-[3px] border-purple-400/60 min-w-0 overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 border-b border-border/20 bg-purple-500/[0.04]">
            <span className="text-[10px] font-mono text-purple-300/70 truncate min-w-0 mr-1">
              → {seg.theirsLabel || "theirs"}
            </span>
            <div className="flex gap-1 shrink-0">
              <ChoiceButton active={resolution?.mode === "both"} tint="teal" label="Both" onClick={() => onSetMode("both")} />
              <ChoiceButton active={resolution?.mode === "theirs"} tint="purple" label="Theirs" onClick={() => onSetMode("theirs")} />
            </div>
          </div>
          {seg.theirs.length > 0
            ? seg.theirs.map((line, i) => (
                <ToggleableLine key={i} text={line} lineNo={i} tint="purple"
                  included={isIncluded(resolution, "theirs", i)}
                  onToggle={() => onToggleLine("theirs", i)}
                />
              ))
            : <div className="px-3 py-3 text-[10px] italic text-muted-foreground/35">(empty)</div>
          }
        </div>

        {/* Result */}
        <div className="border-l-[3px] border-teal-400/40 min-w-0 overflow-hidden">
          <div className="flex items-center px-2 py-1 border-b border-border/20 bg-teal-500/[0.04] justify-between">
            <span className="text-[10px] text-teal-300/60 uppercase tracking-widest font-semibold">
              Result
            </span>
            {resolution?.mode === "custom" && (
              resolution.approved ? (
                <span className="text-[10px] text-teal-300 font-medium flex items-center gap-1 select-none">
                  ✓ Accepted
                </span>
              ) : (
                <button
                  onClick={onApproveCustom}
                  className="text-[9px] px-2 py-0.5 rounded bg-teal-500/20 text-teal-200 border border-teal-500/35 hover:bg-teal-500/30 transition-colors font-medium cursor-pointer"
                >
                  Accept Selection
                </button>
              )
            )}
          </div>
          {resolvedLines === null ? (
            <div className="px-3 py-3 text-[10px] italic text-muted-foreground/30">
              Click ○ lines to include…
            </div>
          ) : resolvedLines.length === 0 ? (
            <div className="px-3 py-3 text-[10px] italic text-muted-foreground/35">(empty)</div>
          ) : (
            resolvedLines.map((line, i) => <ResultLine key={i} text={line} lineNo={i} />)
          )}
        </div>
      </div>
    </div>
  );
}

// ── Full-file result preview ──────────────────────────────────────────────────

function ResultFilePreview({
  segments, resolutions,
}: {
  segments: Segment[];
  resolutions: Map<number, HunkResolution>;
}) {
  type Row =
    | { type: "line"; lineNo: number; text: string; resolved: boolean }
    | { type: "unresolved"; conflictIdx: number }
    | { type: "empty-resolved" };

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    let lineNo = 1;

    for (const seg of segments) {
      if (seg.kind === "context") {
        for (const line of seg.lines) {
          result.push({ type: "line", lineNo: lineNo++, text: line, resolved: false });
        }
      } else {
        const res   = resolutions.get(seg.idx);
        const lines = getResolvedLines(seg, res);
        if (lines === null) {
          result.push({ type: "unresolved", conflictIdx: seg.idx });
        } else if (lines.length === 0) {
          result.push({ type: "empty-resolved" });
        } else {
          for (const line of lines) {
            result.push({ type: "line", lineNo: lineNo++, text: line, resolved: true });
          }
        }
      }
    }
    return result;
  }, [segments, resolutions]);

  return (
    <div className="flex-1 overflow-y-auto min-h-0 font-mono text-[11px] leading-[1.7]">
      {rows.map((row, i) => {
        if (row.type === "unresolved") {
          return (
            <div key={i} className="flex items-center gap-2 px-4 py-1.5 bg-orange-500/10 border-y border-orange-400/20 text-[10px] text-orange-300/70">
              ⚠ Conflict {row.conflictIdx + 1} — not yet resolved
            </div>
          );
        }
        if (row.type === "empty-resolved") {
          return (
            <div key={i} className="px-4 py-0.5 text-[10px] italic text-muted-foreground/30 bg-teal-500/5 border-y border-teal-400/10">
              (resolved to empty — lines removed)
            </div>
          );
        }
        return (
          <div key={i} className={`flex items-start ${row.resolved ? "bg-teal-500/[0.07]" : ""}`}>
            <span className="w-10 shrink-0 text-right pr-3 text-muted-foreground/25 select-none border-r border-border/20">
              {row.lineNo}
            </span>
            <span className={`pl-3 whitespace-pre overflow-hidden ${row.resolved ? "text-teal-100/80" : "text-foreground/75"}`}>
              {row.text || "\u200b"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface Props {
  repoId: string;
  path: string;
  viewMode: ViewMode;
  onResolved: () => void;
}

export function ConflictHunkPicker({ repoId, path, viewMode, onResolved }: Props) {
  const [segments,    setSegments]    = useState<Segment[] | null>(null);
  const [resolutions, setResolutions] = useState<Map<number, HunkResolution>>(new Map());
  const [applying,    setApplying]    = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [activeTab,   setActiveTab]   = useState<"conflicts" | "result">("conflicts");
  // Guard against double-apply if resolutions state flickers
  const appliedRef = useRef(false);

  // Load file on selection change
  useEffect(() => {
    let mounted = true;
    appliedRef.current = false;
    setSegments(null);
    setResolutions(new Map());
    setError(null);
    setActiveTab("conflicts");
    ipc
      .getConflictContent(repoId, path)
      .then((content) => { if (mounted) setSegments(parseConflictFile(content)); })
      .catch((e)      => { if (mounted) setError(String(e)); });
    return () => { mounted = false; };
  }, [repoId, path]);

  // Auto-apply once all conflict hunks in this file have a finalized resolution
  useEffect(() => {
    if (!segments || appliedRef.current) return;
    const conflicts = segments.filter((s): s is ConflictSeg => s.kind === "conflict");
    if (conflicts.length === 0 || !conflicts.every((s) => isFinalized(resolutions.get(s.idx)))) return;
    appliedRef.current = true;
    setApplying(true);
    ipc
      .resolveWithContent(repoId, path, buildResolved(segments, resolutions))
      .then(() => onResolved())
      .catch((e) => { setError(String(e)); setApplying(false); appliedRef.current = false; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolutions, segments]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const conflicts = useMemo(
    () => segments?.filter((s): s is ConflictSeg => s.kind === "conflict") ?? [],
    [segments],
  );
  const resolved = conflicts.filter((s) => isFinalized(resolutions.get(s.idx))).length;

  // ── Handlers ─────────────────────────────────────────────────────────────

  function setMode(idx: number, mode: "ours" | "theirs" | "both") {
    setResolutions((prev) => withModeSet(prev, idx, mode));
  }

  function toggleLine(seg: ConflictSeg, side: "ours" | "theirs", lineIdx: number) {
    setResolutions((prev) => withLineToggled(prev, seg, side, lineIdx));
  }

  function approveCustom(idx: number) {
    setResolutions((prev) => {
      const cur = prev.get(idx);
      if (cur && cur.mode === "custom") {
        const next = new Map(prev);
        next.set(idx, { ...cur, approved: true });
        return next;
      }
      return prev;
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-xs text-destructive">{error}</div>
    );
  }

  if (!segments || applying) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2">
        <Loader2 size={15} className="animate-spin text-muted-foreground/40" />
        <span className="text-xs text-muted-foreground/50">
          {applying ? "Applying resolution…" : "Loading…"}
        </span>
      </div>
    );
  }

  if (conflicts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/50 italic">
        No conflict markers found in this file.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

      {/* ── Tab bar + progress ── */}
      <div className="shrink-0 flex items-center gap-4 px-4 py-2 border-b border-border/40">
        {/* Tabs */}
        <div className="flex rounded border border-border/50 text-[10px] overflow-hidden">
          {(["conflicts", "result"] as const).map((tab, i) => (
            <button
              key={tab}
              className={`px-3 py-1 transition-colors ${i > 0 ? "border-l border-border/40" : ""} ${
                activeTab === tab
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground/55 hover:text-foreground"
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "result" ? "Result Preview" : "Conflicts"}
            </button>
          ))}
        </div>

        {/* Progress bar */}
        <div className="flex-1 flex items-center gap-2">
          <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full bg-teal-500/60 rounded-full transition-all duration-300"
              style={{ width: `${(resolved / conflicts.length) * 100}%` }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
            {resolved}/{conflicts.length}
          </span>
        </div>
      </div>

      {/* ── Content ── */}
      {activeTab === "conflicts" ? (
        <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-4 pt-3">
          {conflicts.map((seg, num) =>
            viewMode === "side-by-side" ? (
              <SideBySideHunk
                key={seg.idx} seg={seg} num={num + 1} total={conflicts.length}
                resolution={resolutions.get(seg.idx)}
                onSetMode={(mode) => setMode(seg.idx, mode)}
                onToggleLine={(side, li) => toggleLine(seg, side, li)}
                onApproveCustom={() => approveCustom(seg.idx)}
              />
            ) : (
              <StackedHunk
                key={seg.idx} seg={seg} num={num + 1} total={conflicts.length}
                resolution={resolutions.get(seg.idx)}
                onSetMode={(mode) => setMode(seg.idx, mode)}
                onToggleLine={(side, li) => toggleLine(seg, side, li)}
                onApproveCustom={() => approveCustom(seg.idx)}
              />
            ),
          )}
        </div>
      ) : (
        <ResultFilePreview segments={segments} resolutions={resolutions} />
      )}
    </div>
  );
}
