import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
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

export function useHeadInfo(repoId: string | null) {
  return useQuery({
    queryKey: ["head", repoId],
    queryFn: () => ipc.getHeadInfo(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

export function useFileStatus(repoId: string | null) {
  return useQuery({
    queryKey: ["staging", repoId],
    queryFn: () => ipc.listStatus(repoId!),
    enabled: !!repoId,
    refetchInterval: 2000,
  });
}

export function useRepoStatus(repoId: string | null) {
  return useQuery({
    queryKey: ["status", repoId],
    queryFn: () => ipc.getRepoStatus(repoId!),
    enabled: !!repoId,
    refetchInterval: 3000,
  });
}

export function useMergeStatus(repoId: string | null) {
  return useQuery({
    queryKey: ["merge-status", repoId],
    queryFn: () => ipc.getMergeStatus(repoId!),
    enabled: !!repoId,
    refetchInterval: 2000,
  });
}

/** Invalidates commits, refs, head, and status after a mutating action. */
export function useRefreshRepo(repoId: string | null) {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: ["commits", repoId] });
    qc.invalidateQueries({ queryKey: ["refs", repoId] });
    qc.invalidateQueries({ queryKey: ["head", repoId] });
    qc.invalidateQueries({ queryKey: ["status", repoId] });
    qc.invalidateQueries({ queryKey: ["staging", repoId] });
    qc.invalidateQueries({ queryKey: ["merge-status", repoId] });
  }, [qc, repoId]);
}
