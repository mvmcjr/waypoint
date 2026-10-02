import type { BranchUpstream, RemoteInfo } from "@/lib/ipc";

/** The remote fetch uses: "origin" if present, otherwise the first remote. */
export function getDefaultRemote(remotes: RemoteInfo[]): string {
  return remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? "";
}

/**
 * The remote pull/push should use: the branch's upstream remote when it has
 * one (and that remote still exists), otherwise the default remote. "" when
 * there are no remotes.
 */
export function chooseRemote(remotes: RemoteInfo[], upstream: BranchUpstream | null | undefined): string {
  if (upstream && remotes.some((r) => r.name === upstream.remote)) return upstream.remote;
  return getDefaultRemote(remotes);
}
