import type { RemoteInfo } from "@/lib/ipc";

/** The remote fetch uses: "origin" if present, otherwise the first remote. */
export function getDefaultRemote(remotes: RemoteInfo[]): string {
  return remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? "";
}
