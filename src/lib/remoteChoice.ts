import type { RemoteInfo, SyncTargets } from "@/lib/ipc";

/** The remote fetch uses: "origin" if present, otherwise the first remote. */
export function getDefaultRemote(remotes: RemoteInfo[]): string {
  return remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? "";
}

/**
 * Remotes a fetch should hit: the default remote, the branch's pull remote and
 * its push remote (pushRemote/pushDefault), deduplicated in that order. The push
 * remote matters in a triangular workflow: a stale `refs/remotes/<fork>/*` hides
 * what a push would overwrite.
 */
export function remotesToFetch(defaultRemote: string, targets: SyncTargets | null | undefined): string[] {
  const names = [defaultRemote];
  for (const r of [targets?.pull?.remote, targets?.push?.remote]) {
    if (r && !names.includes(r)) names.push(r);
  }
  return names;
}
