import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { ipc } from "@/lib/ipc";

// ── Types ─────────────────────────────────────────────────────────────────────

type Choice = "ours" | "theirs" | "both";

type Segment =
  | { kind: "context"; lines: string[] }
  | { kind: "conflict"; idx: number; oursLabel: string; ours: string[]; theirs: string[]; theirsLabel: string };

// ── Parser / builder (unchanged logic) ────────────────────────────────────────

function parseConflictFile(content: string): Segment[] {
  const lines = content.split("\n");
  const segments: Segment[] = [];
  let contextBuf: string[] = [];
  let idx = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("<<<<<<<")) {
      if (contextBuf.length > 0) {
        segments.push({ kind: "context", lines: contextBuf });
        contextBuf = [];
      }
      const oursLabel = line.slice(7).trim();
      const ours: string[] = [];
      const theirs: string[] = [];
      let theirsLabel = "";
      let state: "ours" | "base" | "theirs" = "ours";
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith(">>>>>>>")) {
          theirsLabel = l.slice(7).trim();
          i++;
          break;
        } else if (l.startsWith("=======")) {
          state = "theirs";
        } else if (l.startsWith("|||||||")) {
          state = "base"; // diff3 base — skip
        } else if (state === "ours") {
          ours.push(l);
        } else if (state === "theirs") {
          theirs.push(l);
        }
        i++;
      }
      segments.push({ kind: "conflict", idx: idx++, oursLabel, ours, theirs, theirsLabel });
    } else {
      contextBuf.push(line);
      i++;
    }
  }
  if (contextBuf.length > 0) {
    segments.push({ kind: "context", lines: contextBuf });
  }
  return segments;
}

function buildResolved(segments: Segment[], choices: Map<number, Choice>): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "context") {
      parts.push(seg.lines.join("\n"));
    } else {
      const c = choices.get(seg.idx)!;
      if (c === "ours") parts.push(seg.ours.join("\n"));
      else if (c === "theirs") parts.push(seg.theirs.join("\n"));
      else parts.push([...seg.ours, ...seg.theirs].join("\n"));
    }
  }
  return parts.filter((p) => p !== "").join("\n");
}

// ── Code display helpers ───────────────────────────────────────────────────────

function CodeBlock({
  lines,
  tint,
  placeholder = "(empty — this side deletes these lines)",
}: {
  lines: string[];
  tint: "blue" | "purple";
  placeholder?: string;
}) {
  const textColor = tint === "blue" ? "text-blue-100/80" : "text-purple-100/80";
  const bgStripe  = tint === "blue" ? "bg-blue-500/[0.07]" : "bg-purple-500/[0.07]";

  if (lines.length === 0) {
    return (
      <div className={`px-3 py-2 font-mono text-[11px] italic text-muted-foreground/40 ${bgStripe}`}>
        {placeholder}
      </div>
    );
  }

  return (
    <div className={`font-mono text-[11px] leading-[1.7] overflow-x-auto ${textColor} ${bgStripe}`}>
      {lines.map((line, i) => (
        <div key={i} className="flex items-start min-w-0">
          <span className="w-8 shrink-0 text-right pr-2 text-muted-foreground/30 select-none border-r border-white/5">
            {i + 1}
          </span>
          <span className="pl-2 whitespace-pre min-w-0">{line || "\u200b"}</span>
        </div>
      ))}
    </div>
  );
}

// ── Hunk card — stacked layout ────────────────────────────────────────────────

function StackedHunk({
  seg,
  num,
  total,
  choice,
  onPick,
}: {
  seg: Extract<Segment, { kind: "conflict" }>;
  num: number;
  total: number;
  choice: Choice | undefined;
  onPick: (c: Choice) => void;
}) {
  return (
    <div className="border border-border/50 rounded-lg overflow-hidden mb-4">
      {/* Counter badge */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.03] border-b border-border/40">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Conflict {num} of {total}
        </span>
        {choice && (
          <span className="text-[10px] text-green-400/80 font-medium">✓ resolved</span>
        )}
      </div>

      {/* Ours */}
      <div className={`border-l-[3px] border-blue-400/60 transition-colors ${choice === "ours" || choice === "both" ? "bg-blue-500/[0.12]" : ""}`}>
        <div className="flex items-center justify-between px-3 py-1 border-b border-border/20">
          <span className="text-[10px] font-mono text-blue-300/70 truncate min-w-0 mr-2">
            ← {seg.oursLabel || "HEAD"}
          </span>
          <ChoiceButton active={choice === "ours"} tint="blue" label="Ours" onClick={() => onPick("ours")} />
        </div>
        <CodeBlock lines={seg.ours} tint="blue" />
      </div>

      {/* Separator */}
      <div className="h-px bg-border/40" />

      {/* Theirs */}
      <div className={`border-l-[3px] border-purple-400/60 transition-colors ${choice === "theirs" || choice === "both" ? "bg-purple-500/[0.12]" : ""}`}>
        <div className="flex items-center justify-between px-3 py-1 border-b border-border/20">
          <span className="text-[10px] font-mono text-purple-300/70 truncate min-w-0 mr-2">
            → {seg.theirsLabel || "theirs"}
          </span>
          <div className="flex gap-1.5 shrink-0">
            <ChoiceButton active={choice === "both"} tint="teal" label="Both" onClick={() => onPick("both")} />
            <ChoiceButton active={choice === "theirs"} tint="purple" label="Theirs" onClick={() => onPick("theirs")} />
          </div>
        </div>
        <CodeBlock lines={seg.theirs} tint="purple" />
      </div>
    </div>
  );
}

// ── Hunk card — side-by-side layout ──────────────────────────────────────────

function SideBySideHunk({
  seg,
  num,
  total,
  choice,
  onPick,
}: {
  seg: Extract<Segment, { kind: "conflict" }>;
  num: number;
  total: number;
  choice: Choice | undefined;
  onPick: (c: Choice) => void;
}) {
  const maxLines = Math.max(seg.ours.length, seg.theirs.length);

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden mb-4">
      {/* Counter badge */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.03] border-b border-border/40">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Conflict {num} of {total}
        </span>
        {choice && (
          <span className="text-[10px] text-green-400/80 font-medium">✓ resolved</span>
        )}
      </div>

      {/* Side-by-side panes */}
      <div className="flex divide-x divide-border/40">
        {/* Ours */}
        <div className={`flex-1 min-w-0 border-l-[3px] border-blue-400/60 transition-colors ${choice === "ours" || choice === "both" ? "bg-blue-500/[0.12]" : ""}`}>
          <div className="flex items-center justify-between px-3 py-1 border-b border-border/20">
            <span className="text-[10px] font-mono text-blue-300/70 truncate min-w-0 mr-2">
              ← {seg.oursLabel || "HEAD"}
            </span>
            <ChoiceButton active={choice === "ours"} tint="blue" label="Ours" onClick={() => onPick("ours")} />
          </div>
          <div className="font-mono text-[11px] leading-[1.7] overflow-x-auto text-blue-100/80">
            {maxLines === 0 ? (
              <div className="px-3 py-2 italic text-muted-foreground/40 text-[11px]">(empty)</div>
            ) : (
              Array.from({ length: maxLines }, (_, i) => {
                const line = seg.ours[i];
                return (
                  <div key={i} className="flex items-start">
                    <span className="w-8 shrink-0 text-right pr-2 text-muted-foreground/30 select-none border-r border-white/5">
                      {i + 1}
                    </span>
                    <span className="pl-2 whitespace-pre min-w-0">{line ?? ""}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Theirs */}
        <div className={`flex-1 min-w-0 border-l-[3px] border-purple-400/60 transition-colors ${choice === "theirs" || choice === "both" ? "bg-purple-500/[0.12]" : ""}`}>
          <div className="flex items-center justify-between px-3 py-1 border-b border-border/20">
            <span className="text-[10px] font-mono text-purple-300/70 truncate min-w-0 mr-2">
              → {seg.theirsLabel || "theirs"}
            </span>
            <div className="flex gap-1.5 shrink-0">
              <ChoiceButton active={choice === "both"} tint="teal" label="Both" onClick={() => onPick("both")} />
              <ChoiceButton active={choice === "theirs"} tint="purple" label="Theirs" onClick={() => onPick("theirs")} />
            </div>
          </div>
          <div className="font-mono text-[11px] leading-[1.7] overflow-x-auto text-purple-100/80">
            {maxLines === 0 ? (
              <div className="px-3 py-2 italic text-muted-foreground/40 text-[11px]">(empty)</div>
            ) : (
              Array.from({ length: maxLines }, (_, i) => {
                const line = seg.theirs[i];
                return (
                  <div key={i} className="flex items-start">
                    <span className="w-8 shrink-0 text-right pr-2 text-muted-foreground/30 select-none border-r border-white/5">
                      {i + 1}
                    </span>
                    <span className="pl-2 whitespace-pre min-w-0">{line ?? ""}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Both button row */}
      {choice !== "both" && (
        <div className="border-t border-border/30 px-3 py-1.5 flex justify-end">
          <ChoiceButton active={false} tint="teal" label="Accept Both" onClick={() => onPick("both")} />
        </div>
      )}
    </div>
  );
}

// ── Shared choice pill button ─────────────────────────────────────────────────

function ChoiceButton({
  active,
  tint,
  label,
  onClick,
}: {
  active: boolean;
  tint: "blue" | "purple" | "teal";
  label: string;
  onClick: () => void;
}) {
  const base = "shrink-0 text-[10px] px-2 py-0.5 rounded-full border transition-colors font-medium";
  const styles = {
    blue:   active ? "bg-blue-500/30 text-blue-200 border-blue-400/60"     : "text-blue-300/55 border-blue-400/25 hover:text-blue-200 hover:bg-blue-500/20",
    purple: active ? "bg-purple-500/30 text-purple-200 border-purple-400/60" : "text-purple-300/55 border-purple-400/25 hover:text-purple-200 hover:bg-purple-500/20",
    teal:   active ? "bg-teal-500/25 text-teal-200 border-teal-400/50"     : "text-muted-foreground/45 border-border/40 hover:text-teal-200 hover:bg-teal-500/15",
  };
  return (
    <button className={`${base} ${styles[tint]}`} onClick={onClick}>
      {active ? `✓ ${label}` : label}
    </button>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export type ViewMode = "stacked" | "side-by-side";

interface Props {
  repoId: string;
  path: string;
  viewMode: ViewMode;
  onResolved: () => void;
}

export function ConflictHunkPicker({ repoId, path, viewMode, onResolved }: Props) {
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [choices, setChoices]   = useState<Map<number, Choice>>(new Map());
  const [applying, setApplying] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // Reload whenever the selected file changes
  useEffect(() => {
    let mounted = true;
    setSegments(null);
    setChoices(new Map());
    setError(null);
    ipc
      .getConflictContent(repoId, path)
      .then((content) => { if (mounted) setSegments(parseConflictFile(content)); })
      .catch((e)      => { if (mounted) setError(String(e)); });
    return () => { mounted = false; };
  }, [repoId, path]);

  // Auto-apply as soon as all hunks in this file are resolved
  useEffect(() => {
    if (!segments) return;
    const conflicts = segments.filter((s): s is Extract<Segment, { kind: "conflict" }> => s.kind === "conflict");
    if (conflicts.length === 0) return;
    const allDone = conflicts.every((s) => choices.has(s.idx));
    if (!allDone || applying) return;

    setApplying(true);
    ipc
      .resolveWithContent(repoId, path, buildResolved(segments, choices))
      .then(() => { onResolved(); })
      .catch((e) => { setError(String(e)); setApplying(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-xs text-destructive">
        {error}
      </div>
    );
  }

  if (!segments) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  const conflicts = segments.filter(
    (s): s is Extract<Segment, { kind: "conflict" }> => s.kind === "conflict",
  );

  if (conflicts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/50 italic">
        No conflict markers found in this file.
      </div>
    );
  }

  if (applying) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        Applying resolution…
      </div>
    );
  }

  function pick(idx: number, choice: Choice) {
    setChoices((prev) => new Map(prev).set(idx, choice));
  }

  const resolved = conflicts.filter((s) => choices.has(s.idx)).length;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Progress bar */}
      <div className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground/50 mb-1.5">
          <span>{conflicts.length - resolved} conflict{conflicts.length - resolved !== 1 ? "s" : ""} remaining</span>
          <span>{resolved} / {conflicts.length} resolved</span>
        </div>
        <div className="h-1 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full bg-teal-500/60 rounded-full transition-all duration-300"
            style={{ width: `${(resolved / conflicts.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Hunk list */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-4">
        {conflicts.map((seg, num) =>
          viewMode === "side-by-side" ? (
            <SideBySideHunk
              key={seg.idx}
              seg={seg}
              num={num + 1}
              total={conflicts.length}
              choice={choices.get(seg.idx)}
              onPick={(c) => pick(seg.idx, c)}
            />
          ) : (
            <StackedHunk
              key={seg.idx}
              seg={seg}
              num={num + 1}
              total={conflicts.length}
              choice={choices.get(seg.idx)}
              onPick={(c) => pick(seg.idx, c)}
            />
          ),
        )}
      </div>
    </div>
  );
}
