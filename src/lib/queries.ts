import { useQuery } from "@tanstack/react-query";
import { ipc } from "./ipc";

export function useCommits(repoId: string | null) {
  return useQuery({
    queryKey: ["commits", repoId],
    queryFn: () => ipc.walkCommits(repoId!, 2000),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

export function useRefs(repoId: string | null) {
  return useQuery({
    queryKey: ["refs", repoId],
    queryFn: () => ipc.listRefs(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

export function useCommitDiff(repoId: string | null, oid: string | null) {
  return useQuery({
    queryKey: ["diff", repoId, oid],
    queryFn: () => ipc.getCommitDiff(repoId!, oid!),
    enabled: !!repoId && !!oid,
    staleTime: Infinity,
  });
}
