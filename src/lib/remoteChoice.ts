import type { RemoteInfo, SyncTargets } from "@/lib/ipc";

/** The remote fetch uses: "origin" if present, otherwise the first remote. */
export function getDefaultRemote(remotes: RemoteInfo[]): string {
  return remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? "";
}

/**
 * Remotes a fetch should hit: the default remote plus the branch's upstream
 * remote when it differs (the backend resolves that remote as `targets.pull`).
 */
export function remotesToFetch(defaultRemote: string, targets: SyncTargets | null | undefined): string[] {
  const upstream = targets?.pull?.remote;
  return upstream && upstream !== defaultRemote ? [defaultRemote, upstream] : [defaultRemote];
}
