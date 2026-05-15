import { useState, useEffect } from "react";
import { Loader2, Check } from "lucide-react";
import { ipc } from "@/lib/ipc";

type Choice = "ours" | "theirs" | "both";

type Segment =
  | { kind: "context"; lines: string[] }
  | { kind: "conflict"; idx: number; oursLabel: string; ours: string[]; theirs: string[]; theirsLabel: string };

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
          // diff3 base section — skip
          state = "base";
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
  // Filter empty parts so that accepting an empty section doesn't leave a blank line.
  return parts.filter((p) => p !== "").join("\n");
}

const MAX_LINES = 8;

function CodeLines({ lines, tint }: { lines: string[]; tint: "blue" | "purple" }) {
  const colorClass = tint === "blue" ? "text-blue-100/75" : "text-purple-100/75";
  const shown: (string | null)[] =
    lines.length > MAX_LINES ? [...lines.slice(0, 6), null, ...lines.slice(-2)] : lines;
  return (
    <div className={`font-mono text-[10px] overflow-x-auto leading-[1.65] ${colorClass}`}>
      {shown.map((line, i) =>
        line === null ? (
          <div key={i} className="px-2 italic text-muted-foreground/40">
            …{lines.length - MAX_LINES} more lines
          </div>
        ) : (
          <div key={i} className="px-2 whitespace-pre">
            {line || "​"}
          </div>
        ),
      )}
    </div>
  );
}

interface Props {
  repoId: string;
  path: string;
  onResolved: () => void;
}

export function ConflictHunkPicker({ repoId, path, onResolved }: Props) {
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [choices, setChoices] = useState<Map<number, Choice>>(new Map());
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setSegments(null);
    setChoices(new Map());
    setError(null);
    ipc
      .getConflictContent(repoId, path)
      .then((content) => { if (mounted) setSegments(parseConflictFile(content)); })
      .catch((e) => { if (mounted) setError(String(e)); });
    return () => { mounted = false; };
  }, [repoId, path]);

  if (error) {
    return <div className="px-3 py-2 text-xs text-destructive">{error}</div>;
  }

  if (!segments) {
    return (
      <div className="flex justify-center py-3">
        <Loader2 size={13} className="animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  const conflicts = segments.filter(
    (s): s is Extract<Segment, { kind: "conflict" }> => s.kind === "conflict",
  );

  if (conflicts.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground/60 italic">
        No conflict markers found — use Ours or Theirs above to stage.
      </div>
    );
  }

  const resolvedCount = conflicts.filter((s) => choices.has(s.idx)).length;
  const allResolved = resolvedCount === conflicts.length;

  function pick(idx: number, choice: Choice) {
    setChoices((prev) => new Map(prev).set(idx, choice));
  }

  async function applyResolution() {
    if (!allResolved || !segments) return;
    setApplying(true);
    setError(null);
    try {
      await ipc.resolveWithContent(repoId, path, buildResolved(segments, choices));
      onResolved();
    } catch (e) {
      setError(String(e));
      setApplying(false);
    }
  }

  return (
    <div className="pb-2">
      {conflicts.map((seg, num) => {
        const choice = choices.get(seg.idx);
        const oursActive = choice === "ours" || choice === "both";
        const theirsActive = choice === "theirs" || choice === "both";

        return (
          <div key={seg.idx} className="mx-2 mb-1.5 rounded border border-border/40 overflow-hidden text-xs">
            {/* Conflict counter */}
            <div className="px-2 py-0.5 bg-white/[0.03] border-b border-border/30 text-[9px] text-muted-foreground/50 uppercase tracking-wide">
              Conflict {num + 1} of {conflicts.length}
            </div>

            {/* Ours section */}
            <div
              className={`border-l-2 border-blue-400/50 transition-colors ${oursActive ? "bg-blue-500/[0.14]" : "bg-blue-500/[0.05]"}`}
            >
              <div className="flex items-center justify-between px-2 py-0.5 gap-2">
                <span className="text-[9px] text-blue-300/70 font-medium truncate min-w-0">
                  {seg.oursLabel || "HEAD"}
                </span>
                <button
                  onClick={() => pick(seg.idx, "ours")}
                  className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                    choice === "ours"
                      ? "bg-blue-500/30 text-blue-200 border border-blue-400/50"
                      : "text-blue-300/55 hover:text-blue-200 hover:bg-blue-500/20"
                  }`}
                >
                  {choice === "ours" ? "✓ Ours" : "Ours"}
                </button>
              </div>
              {seg.ours.length > 0 ? (
                <CodeLines lines={seg.ours} tint="blue" />
              ) : (
                <div className="px-2 pb-1 font-mono text-[10px] text-muted-foreground/35 italic">(empty)</div>
              )}
            </div>

            {/* Theirs section */}
            <div
              className={`border-l-2 border-purple-400/50 border-t border-t-border/30 transition-colors ${theirsActive ? "bg-purple-500/[0.14]" : "bg-purple-500/[0.05]"}`}
            >
              <div className="flex items-center justify-between px-2 py-0.5 gap-2">
                <span className="text-[9px] text-purple-300/70 font-medium truncate min-w-0">
                  {seg.theirsLabel || "theirs"}
                </span>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => pick(seg.idx, "both")}
                    className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                      choice === "both"
                        ? "bg-teal-500/25 text-teal-200 border border-teal-400/40"
                        : "text-muted-foreground/45 hover:text-teal-200 hover:bg-teal-500/15"
                    }`}
                  >
                    {choice === "both" ? "✓ Both" : "Both"}
                  </button>
                  <button
                    onClick={() => pick(seg.idx, "theirs")}
                    className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                      choice === "theirs"
                        ? "bg-purple-500/30 text-purple-200 border border-purple-400/50"
                        : "text-purple-300/55 hover:text-purple-200 hover:bg-purple-500/20"
                    }`}
                  >
                    {choice === "theirs" ? "✓ Theirs" : "Theirs"}
                  </button>
                </div>
              </div>
              {seg.theirs.length > 0 ? (
                <CodeLines lines={seg.theirs} tint="purple" />
              ) : (
                <div className="px-2 pb-1 font-mono text-[10px] text-muted-foreground/35 italic">(empty)</div>
              )}
            </div>
          </div>
        );
      })}

      {error && <p className="px-3 py-1 text-xs text-destructive break-words">{error}</p>}

      <div className="px-2 pt-0.5">
        {allResolved ? (
          <button
            onClick={applyResolution}
            disabled={applying}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs bg-teal-500/20 text-teal-300 border border-teal-400/30 hover:bg-teal-500/30 disabled:opacity-50 transition-colors"
          >
            {applying ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
            Apply Resolution
          </button>
        ) : (
          <p className="text-center text-[10px] text-muted-foreground/40 py-0.5">
            {conflicts.length - resolvedCount} conflict{conflicts.length - resolvedCount !== 1 ? "s" : ""} remaining
          </p>
        )}
      </div>
    </div>
  );
}
