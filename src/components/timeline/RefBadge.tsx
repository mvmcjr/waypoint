import { Monitor, Globe } from "lucide-react";

export interface RefGroup {
  /** Display name (branch name without remote prefix). */
  name: string;
  hasLocal: boolean;
  hasRemote: boolean;
  isHead: boolean;
}

/** Parse a commit's raw ref shorthand strings into display groups. */
export function groupRefs(refs: string[], headBranch: string | null): RefGroup[] {
  // Drop bare HEAD pointers — they're implicit from headBranch.
  const visible = refs.filter((r) => r !== "HEAD" && r !== "origin/HEAD");

  // Local branches have no slash; remote tracking branches start with "<remote>/".
  const locals = visible.filter((r) => !r.includes("/"));
  const remotes = visible.filter((r) => r.includes("/"));

  const usedRemotes = new Set<string>();
  const groups: RefGroup[] = [];

  // Pair each local branch with its remote counterpart (any "<remote>/name" suffix).
  for (const local of locals) {
    const matched = remotes.filter((r) => {
      const slash = r.indexOf("/");
      return slash !== -1 && r.slice(slash + 1) === local;
    });
    matched.forEach((r) => usedRemotes.add(r));
    groups.push({ name: local, hasLocal: true, hasRemote: matched.length > 0, isHead: local === headBranch });
  }

  // Remote-only refs (no matching local branch).
  for (const remote of remotes) {
    if (usedRemotes.has(remote)) continue;
    const slash = remote.indexOf("/");
    const name = slash !== -1 ? remote.slice(slash + 1) : remote;
    groups.push({ name, hasLocal: false, hasRemote: true, isHead: false });
  }

  return groups;
}

interface Props extends RefGroup {}

export function RefBadge({ name, hasLocal, hasRemote, isHead }: Props) {
  const base =
    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold shrink-0 max-w-full";

  if (isHead) {
    return (
      <span className={`${base} bg-green-500/25 text-green-300 border border-green-400/60 ring-1 ring-green-400/20`}>
        <span className="text-[9px]">✓</span>
        <span className="truncate">{name}</span>
        {hasLocal && <Monitor size={9} className="shrink-0 opacity-80" />}
        {hasRemote && <Globe size={9} className="shrink-0 opacity-80" />}
      </span>
    );
  }

  return (
    <span className={`${base} bg-blue-500/15 text-blue-300 border border-blue-500/30`}>
      <span className="truncate">{name}</span>
      {hasLocal && <Monitor size={9} className="shrink-0 opacity-60" />}
      {hasRemote && <Globe size={9} className="shrink-0 opacity-60" />}
    </span>
  );
}
