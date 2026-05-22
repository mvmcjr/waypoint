import { Monitor, Globe } from "lucide-react";

export interface RefGroup {
  name: string;
  hasLocal: boolean;
  hasRemote: boolean;
  isHead: boolean;
}

export function groupRefs(
  allRefs: string[],
  localBranches: string[],
  remoteBranches: string[],
  headBranch: string | null,
): RefGroup[] {
  const groups: RefGroup[] = [];
  const covered = new Set<string>(["HEAD"]);

  // Local branches merged with their matching remote tracking branches
  for (const local of localBranches) {
    covered.add(local);
    const matched = remoteBranches.filter((r) => {
      const slash = r.indexOf("/");
      return slash !== -1 && r.slice(slash + 1) === local;
    });
    matched.forEach((r) => covered.add(r));
    groups.push({ name: local, hasLocal: true, hasRemote: matched.length > 0, isHead: local === headBranch });
  }

  // Remote-only branches (no corresponding local branch)
  for (const remote of remoteBranches) {
    if (covered.has(remote)) continue;
    covered.add(remote); // mark as handled before the /HEAD skip so it doesn't leak below
    if (remote.endsWith("/HEAD")) continue;
    const slash = remote.indexOf("/");
    const name = slash !== -1 ? remote.slice(slash + 1) : remote;
    groups.push({ name, hasLocal: false, hasRemote: true, isHead: false });
  }

  // Other refs (tags, etc.) not yet represented
  for (const ref of allRefs) {
    if (covered.has(ref) || ref.endsWith("/HEAD")) continue;
    groups.push({ name: ref, hasLocal: false, hasRemote: false, isHead: false });
  }

  groups.sort((a, b) => (b.isHead ? 1 : 0) - (a.isHead ? 1 : 0));
  return groups;
}

interface Props extends RefGroup {}

export function RefBadge({ name, hasLocal, hasRemote, isHead }: Props) {
  const base = "inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-mono min-w-0 max-w-[124px]";

  if (isHead) {
    return (
      <span className={`${base} bg-teal-500/20 text-teal-300 border border-teal-500/40 font-medium`}>
        <span className="text-[8px] mr-0.5 opacity-80">✓</span>
        <span className="truncate">{name}</span>
        {hasRemote && <Globe size={8} className="shrink-0 opacity-50 ml-0.5" />}
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
