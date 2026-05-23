import { invoke } from "@tauri-apps/api/core";

export interface CommitNode {
  oid: string;
  parent_oids: string[];
  summary: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  refs: string[];
  local_branches: string[];
  remote_branches: string[];
}

export interface GraphEdge {
  from_lane: number;
  to_lane: number;
  color_idx: number;
  from_row: number;
  to_row: number;
}

export interface PositionedCommit {
  commit: CommitNode;
  lane: number;
  row: number;
  color_idx: number;
  edges: GraphEdge[];
}

export interface RefInfo {
  name: string;
  shorthand: string;
  kind: "local_branch" | "remote_branch" | "tag" | "other";
  target_oid: string | null;
  is_head: boolean;
  is_pushed: boolean;
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

export interface HeadInfo {
  oid: string;
  branch: string | null;
}

export interface StatusInfo {
  staged_count: number;
  unstaged_count: number;
  merge_in_progress: boolean;
}

export interface StashEntry {
  index: number;
  message: string;
  oid: string;
}

export interface MergeResult {
  kind: "fast_forward" | "merged" | "up_to_date" | "conflicts";
  conflicted: string[];
}

export interface MergeStatus {
  in_progress: boolean;
  kind: "merge" | "cherry_pick" | "";
  conflicted_paths: string[];
  merge_head_oid: string | null;
  default_message: string;
}

export interface CherryPickResult {
  kind: "applied" | "conflicts";
  conflicted: string[];
}

export interface FileStatus {
  path: string;
  staged: "added" | "modified" | "deleted" | "renamed" | null;
  unstaged: "modified" | "deleted" | "untracked" | "renamed" | null;
}

export interface RemoteInfo {
  name: string;
  url: string;
}

export interface CliShimInfo {
  /** Absolute path where the shim script was written. */
  shim_path: string;
  /** True when we modified the user's PATH (restart terminal to take effect). */
  path_was_updated: boolean;
}

export interface PullResult {
  kind: "up_to_date" | "fast_forward" | "merged" | "conflicts";
  conflicted: string[];
}

export const ipc = {
  getStartupPath: () =>
    invoke<string | null>("get_startup_path"),

  isWindows: () =>
    invoke<boolean>("is_windows"),

  registerExplorerContextMenu: (register: boolean) =>
    invoke<void>("register_explorer_context_menu", { register }),

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

  getWorkdirDiff: (repoId: string, path: string, staged: boolean) =>
    invoke<FileDiff>("get_workdir_diff", { repoId, path, staged }),

  getHeadInfo: (repoId: string) =>
    invoke<HeadInfo>("get_head_info", { repoId }),

  checkoutBranch: (repoId: string, branchName: string, force: boolean) =>
    invoke<void>("checkout_branch", { repoId, branchName, force }),

  checkoutRemoteBranch: (repoId: string, remoteBranch: string, force: boolean) =>
    invoke<void>("checkout_remote_branch", { repoId, remoteBranch, force }),

  checkoutCommit: (repoId: string, oid: string, force: boolean) =>
    invoke<void>("checkout_commit", { repoId, oid, force }),

  createBranchAt: (repoId: string, name: string, oid: string, checkout: boolean) =>
    invoke<void>("create_branch_at", { repoId, name, oid, checkout }),

  resetHead: (repoId: string, oid: string, kind: "soft" | "mixed" | "hard") =>
    invoke<void>("reset_head", { repoId, oid, kind }),

  rebaseOnto: (repoId: string, ontoOid: string) =>
    invoke<void>("rebase_onto", { repoId, ontoOid }),

  deleteBranch: (repoId: string, name: string) =>
    invoke<void>("delete_branch", { repoId, name }),

  getRepoStatus: (repoId: string) =>
    invoke<StatusInfo>("get_repo_status", { repoId }),

  listStatus: (repoId: string) =>
    invoke<FileStatus[]>("list_status", { repoId }),

  stageFile: (repoId: string, path: string) =>
    invoke<void>("stage_file", { repoId, path }),

  unstageFile: (repoId: string, path: string) =>
    invoke<void>("unstage_file", { repoId, path }),

  stageAll: (repoId: string) =>
    invoke<void>("stage_all", { repoId }),

  stagePaths: (repoId: string, paths: string[]) =>
    invoke<void>("stage_paths", { repoId, paths }),

  unstagePaths: (repoId: string, paths: string[]) =>
    invoke<void>("unstage_paths", { repoId, paths }),

  doCommit: (repoId: string, message: string) =>
    invoke<void>("do_commit", { repoId, message }),

  mergeCommit: (repoId: string, oid: string, label: string) =>
    invoke<MergeResult>("merge_commit", { repoId, oid, label }),

  getMergeStatus: (repoId: string) =>
    invoke<MergeStatus>("get_merge_status", { repoId }),

  resolveOurs: (repoId: string, path: string) =>
    invoke<void>("resolve_ours", { repoId, path }),

  resolveTheirs: (repoId: string, path: string) =>
    invoke<void>("resolve_theirs", { repoId, path }),

  finishMerge: (repoId: string, message: string) =>
    invoke<void>("finish_merge", { repoId, message }),

  abortMerge: (repoId: string) =>
    invoke<void>("abort_merge", { repoId }),

  cherryPick: (repoId: string, oid: string) =>
    invoke<CherryPickResult>("cherry_pick", { repoId, oid }),

  finishCherryPick: (repoId: string, message: string) =>
    invoke<void>("finish_cherry_pick", { repoId, message }),

  getConflictContent: (repoId: string, path: string) =>
    invoke<string>("get_conflict_content", { repoId, path }),

  resolveWithContent: (repoId: string, path: string, content: string) =>
    invoke<void>("resolve_with_content", { repoId, path, content }),

  discardAll: (repoId: string) =>
    invoke<void>("discard_all", { repoId }),

  stashPush: (repoId: string, message: string) =>
    invoke<void>("stash_push", { repoId, message }),

  listStashes: (repoId: string) =>
    invoke<StashEntry[]>("list_stashes", { repoId }),

  popStash: (repoId: string, index: number) =>
    invoke<void>("pop_stash", { repoId, index }),

  applyStash: (repoId: string, index: number) =>
    invoke<void>("apply_stash", { repoId, index }),

  dropStash: (repoId: string, index: number) =>
    invoke<void>("drop_stash", { repoId, index }),

  listRemotes: (repoId: string) =>
    invoke<RemoteInfo[]>("list_remotes", { repoId }),

  fetchRemote: (repoId: string, remoteName: string) =>
    invoke<void>("fetch_remote", { repoId, remoteName }),

  pushBranch: (repoId: string, remoteName: string, branchName: string, force: boolean) =>
    invoke<void>("push_branch", { repoId, remoteName, branchName, force }),

  pullBranch: (repoId: string, remoteName: string) =>
    invoke<PullResult>("pull_branch", { repoId, remoteName }),

  createTag: (repoId: string, name: string, oid: string, message: string) =>
    invoke<void>("create_tag", { repoId, name, oid, message }),

  deleteTag: (repoId: string, name: string) =>
    invoke<void>("delete_tag", { repoId, name }),

  pushTag: (repoId: string, remoteName: string, tagName: string) =>
    invoke<void>("push_tag", { repoId, remoteName, tagName }),

  deleteRemoteTag: (repoId: string, remoteName: string, tagName: string) =>
    invoke<void>("delete_remote_tag", { repoId, remoteName, tagName }),

  scanForGitRepos: (path: string) =>
    invoke<string[]>("scan_for_git_repos", { path }),

  registerCliShim: () =>
    invoke<CliShimInfo>("register_cli_shim"),

  unregisterCliShim: () =>
    invoke<void>("unregister_cli_shim"),

  checkCliShim: () =>
    invoke<boolean>("check_cli_shim"),
};
