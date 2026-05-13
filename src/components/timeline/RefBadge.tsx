import { Monitor, Globe } from "lucide-react";

export interface RefGroup {
  name: string;
  hasLocal: boolean;
  hasRemote: boolean;
  isHead: boolean;
}

export function groupRefs(refs: string[], headBranch: string | null): RefGroup[] {
  const visible = refs.filter((r) => r !== "HEAD" && r !== "origin/HEAD");

  const locals = visible.filter((r) => !r.includes("/"));
  const remotes = visible.filter((r) => r.includes("/"));

  const usedRemotes = new Set<string>();
  const groups: RefGroup[] = [];

  for (const local of locals) {
    const matched = remotes.filter((r) => {
      const slash = r.indexOf("/");
      return slash !== -1 && r.slice(slash + 1) === local;
    });
    matched.forEach((r) => usedRemotes.add(r));
    groups.push({ name: local, hasLocal: true, hasRemote: matched.length > 0, isHead: local === headBranch });
  }

  for (const remote of remotes) {
    if (usedRemotes.has(remote)) continue;
    const slash = remote.indexOf("/");
    const name = slash !== -1 ? remote.slice(slash + 1) : remote;
    groups.push({ name, hasLocal: false, hasRemote: true, isHead: false });
  }

  groups.sort((a, b) => (b.isHead ? 1 : 0) - (a.isHead ? 1 : 0));

  return groups;
}

interface Props extends RefGroup {}

export function RefBadge({ name, hasLocal, hasRemote, isHead }: Props) {
  const base = "inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-mono shrink-0 max-w-[124px]";

  if (isHead) {
    return (
      <span className={`${base} bg-teal-500/20 text-teal-300 border border-teal-500/40 font-medium`}>
        <span className="text-[8px] mr-0.5 opacity-80">✓</span>
        <span className="truncate">{name}</span>
      </span>
    );
  }

  const colorClass =
    hasLocal && hasRemote
      ? "bg-indigo-500/15 text-indigo-300/90 border border-indigo-500/25"
      : hasLocal
      ? "bg-slate-500/12 text-slate-300/80 border border-slate-500/20"
      : "bg-slate-600/10 text-slate-400/70 border border-slate-500/15";

  return (
    <span className={`${base} ${colorClass}`}>
      <span className="truncate">{name}</span>
      {hasLocal && <Monitor size={8} className="shrink-0 opacity-40 ml-0.5" />}
      {hasRemote && <Globe size={8} className="shrink-0 opacity-40" />}
    </span>
  );
}
