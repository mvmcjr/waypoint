import { invoke } from "@tauri-apps/api/core";

export interface CommitNode {
  oid: string;
  parent_oids: string[];
  summary: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  refs: string[];
}

export interface GraphEdge {
  from_lane: number;
  to_lane: number;
  from_row: number;
  to_row: number;
}

export interface PositionedCommit {
  commit: CommitNode;
  lane: number;
  row: number;
  color_idx: number;
  active_lanes: (string | null)[];
  edges: GraphEdge[];
}

export interface RefInfo {
  name: string;
  shorthand: string;
  kind: "local_branch" | "remote_branch" | "tag" | "other";
  target_oid: string | null;
  is_head: boolean;
}

export interface FileDiff {
  path: string;
  old_path: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "copied" | "other";
  hunks: Hunk[];
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: "context" | "addition" | "deletion";
  content: string;
}

export const ipc = {
  openRepo: (path: string) =>
    invoke<string>("open_repo", { path }),

  listRefs: (repoId: string) =>
    invoke<RefInfo[]>("list_refs", { repoId }),

  walkCommits: (repoId: string, limit?: number) =>
    invoke<PositionedCommit[]>("walk_commits", { repoId, limit }),

  getCommit: (repoId: string, oid: string) =>
    invoke<CommitNode>("get_commit", { repoId, oid }),

  getCommitDiff: (repoId: string, oid: string) =>
    invoke<FileDiff[]>("get_commit_diff", { repoId, oid }),
};
