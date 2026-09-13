import { invoke } from "@tauri-apps/api/core";

export interface CommitNode {
  oid: string;
  parent_oids: string[];
  summary: string;
  /** Commit message body (everything after the summary line), trimmed. Empty when none. */
  body: string;
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
  /**
   * Set only for local branches checked out in ANOTHER git worktree (not the
   * repo open in this tab) — the value is that worktree's working-directory
   * path. The backend rejects checkout/delete/reset of such a branch.
   */
  worktree_path: string | null;
}

export interface FileDiff {
  path: string;
  old_path: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "copied" | "other";
  /** libgit2 classified the content as binary — `hunks` is empty and no text diff exists. */
  binary: boolean;
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

/** Outcome of checking out a remote tracking branch — see checkout_remote_branch. */
export type CheckoutRemoteResult = "created" | "up_to_date" | "fast_forward" | "detached";

export interface InitTarget {
  /** Root of the repository this folder already sits inside, if any. */
  enclosing_repo: string | null;
}

export interface HeadInfo {
  /** HEAD commit, or null in a fresh repository with no commits yet. */
  oid: string | null;
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
  branch: string | null;
}

export interface MergeResult {
  kind: "fast_forward" | "merged" | "up_to_date" | "conflicts";
  conflicted: string[];
}

export interface MergeStatus {
  in_progress: boolean;
  kind: "merge" | "cherry_pick" | "revert" | "";
  conflicted_paths: string[];
  merge_head_oid: string | null;
  default_message: string;
}

export interface CherryPickResult {
  kind: "staged" | "conflicts";
  conflicted: string[];
  message: string;
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

export interface SquashPreview {
  count: number;
  default_subject: string;
  default_body: string;
}

export interface PullResult {
  kind: "up_to_date" | "fast_forward" | "merged" | "conflicts";
  conflicted: string[];
}

export interface OpenedRepo {
  id: string;
  main_worktree_path: string | null;
}

export interface WorktreeInfo {
  path: string;
  name: string;
  is_main: boolean;
  is_current: boolean;
  branch: string | null;
  head_oid: string | null;
  is_detached: boolean;
  is_locked: boolean;
  lock_reason: string | null;
  is_missing: boolean;
  branch_merged: boolean;
}

export interface WorktreeStatus {
  changed: number;
  conflicted: boolean;
}

export interface RemoveResult {
  branch_deleted: boolean;
  branch_kept_reason: string | null;
}

export const ipc = {
  getStartupPath: () =>
    invoke<string | null>("get_startup_path"),

  isWindows: () =>
    invoke<boolean>("is_windows"),

  registerExplorerContextMenu: (register: boolean) =>
    invoke<void>("register_explorer_context_menu", { register }),

  openRepo: (path: string) =>
    invoke<OpenedRepo>("open_repo", { path }),

  initRepo: (path: string, allowNested = false) =>
    invoke<void>("init_repo", { path, allowNested }),

  checkInitTarget: (path: string) =>
    invoke<InitTarget>("check_init_target", { path }),

  listRefs: (repoId: string) =>
    invoke<RefInfo[]>("list_refs", { repoId }),

  walkCommits: (repoId: string, limit?: number) =>
    invoke<PositionedCommit[]>("walk_commits", { repoId, limit }),

  getCommit: (repoId: string, oid: string) =>
    invoke<CommitNode>("get_commit", { repoId, oid }),

  isCommitInRef: (repoId: string, oid: string, refName: string | null) =>
    invoke<boolean>("is_commit_in_ref", { repoId, oid, refName }),

  getCommitDiff: (repoId: string, oid: string) =>
    invoke<FileDiff[]>("get_commit_diff", { repoId, oid }),

  getCommitFileDiff: (repoId: string, oid: string, path: string) =>
    invoke<FileDiff>("get_commit_file_diff", { repoId, oid, path }),

  getWorkdirDiff: (repoId: string, path: string, staged: boolean) =>
    invoke<FileDiff>("get_workdir_diff", { repoId, path, staged }),

  getWorkdirFileFull: (repoId: string, path: string, staged: boolean) =>
    invoke<FileDiff>("get_workdir_file_full", { repoId, path, staged }),

  stageLine: (repoId: string, path: string, hunkIndex: number, lineIndex: number, fullFile: boolean) =>
    invoke<void>("stage_line", { repoId, path, hunkIndex, lineIndex, fullFile }),

  unstageLine: (repoId: string, path: string, hunkIndex: number, lineIndex: number, fullFile: boolean) =>
    invoke<void>("unstage_line", { repoId, path, hunkIndex, lineIndex, fullFile }),

  stageHunk: (repoId: string, path: string, hunkIndex: number, fullFile: boolean) =>
    invoke<void>("stage_hunk", { repoId, path, hunkIndex, fullFile }),

  unstageHunk: (repoId: string, path: string, hunkIndex: number, fullFile: boolean) =>
    invoke<void>("unstage_hunk", { repoId, path, hunkIndex, fullFile }),

  getHeadInfo: (repoId: string) =>
    invoke<HeadInfo>("get_head_info", { repoId }),

  checkoutBranch: (repoId: string, branchName: string, force: boolean) =>
    invoke<void>("checkout_branch", { repoId, branchName, force }),

  checkoutRemoteBranch: (repoId: string, remoteBranch: string, force: boolean) =>
    invoke<CheckoutRemoteResult>("checkout_remote_branch", { repoId, remoteBranch, force }),

  resetBranchToRemote: (repoId: string, remoteBranch: string) =>
    invoke<void>("reset_branch_to_remote", { repoId, remoteBranch }),

  checkoutCommit: (repoId: string, oid: string, force: boolean) =>
    invoke<void>("checkout_commit", { repoId, oid, force }),

  createBranchAt: (repoId: string, name: string, oid: string, checkout: boolean) =>
    invoke<void>("create_branch_at", { repoId, name, oid, checkout }),

  resetHead: (repoId: string, oid: string, kind: "soft" | "mixed" | "hard") =>
    invoke<void>("reset_head", { repoId, oid, kind }),

  rebaseOnto: (repoId: string, ontoOid: string) =>
    invoke<void>("rebase_onto", { repoId, ontoOid }),

  getSquashPreview: (repoId: string, oids: string[]) =>
    invoke<SquashPreview>("get_squash_preview", { repoId, oids }),

  squashCommits: (repoId: string, oids: string[], message: string) =>
    invoke<void>("squash_commits", { repoId, oids, message }),

  rewordCommit: (repoId: string, oid: string, message: string) =>
    invoke<void>("reword_commit", { repoId, oid, message }),

  deleteBranch: (repoId: string, name: string) =>
    invoke<void>("delete_branch", { repoId, name }),

  renameBranch: (repoId: string, oldName: string, newName: string) =>
    invoke<void>("rename_branch", { repoId, oldName, newName }),

  renameRemoteBranch: (repoId: string, remoteName: string, oldName: string, newName: string) =>
    invoke<void>("rename_remote_branch", { repoId, remoteName, oldName, newName }),

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

  amendCommit: (repoId: string, message: string) =>
    invoke<void>("amend_commit", { repoId, message }),

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

  revertCommit: (repoId: string, oid: string) =>
    invoke<CherryPickResult>("revert_commit", { repoId, oid }),

  finishRevert: (repoId: string, message: string) =>
    invoke<void>("finish_revert", { repoId, message }),

  getConflictContent: (repoId: string, path: string) =>
    invoke<string>("get_conflict_content", { repoId, path }),

  resolveWithContent: (repoId: string, path: string, content: string) =>
    invoke<void>("resolve_with_content", { repoId, path, content }),

  discardFile: (repoId: string, path: string) =>
    invoke<void>("discard_file", { repoId, path }),

  discardPaths: (repoId: string, paths: string[]) =>
    invoke<void>("discard_paths", { repoId, paths }),

  discardAll: (repoId: string) =>
    invoke<void>("discard_all", { repoId }),

  stashPush: (repoId: string, message: string) =>
    invoke<void>("stash_push", { repoId, message }),

  listStashes: (repoId: string) =>
    invoke<StashEntry[]>("list_stashes", { repoId }),

  // Addressed by OID (stable identity) rather than index — all worktrees share
  // one stash list, so an index can shift out from under a pending action.
  popStash: (repoId: string, oid: string) =>
    invoke<void>("pop_stash", { repoId, oid }),

  applyStash: (repoId: string, oid: string) =>
    invoke<void>("apply_stash", { repoId, oid }),

  dropStash: (repoId: string, oid: string) =>
    invoke<void>("drop_stash", { repoId, oid }),

  renameStash: (repoId: string, index: number, message: string) =>
    invoke<void>("rename_stash", { repoId, index, message }),

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

  readLocalPlugin: (path: string) =>
    invoke<{ manifest: string; code: string }>("read_local_plugin", { path }),

  registerCliShim: () =>
    invoke<CliShimInfo>("register_cli_shim"),

  unregisterCliShim: () =>
    invoke<void>("unregister_cli_shim"),

  checkCliShim: () =>
    invoke<boolean>("check_cli_shim"),

  listWorktrees: (repoId: string) =>
    invoke<WorktreeInfo[]>("list_worktrees", { repoId }),

  worktreeStatus: (path: string) =>
    invoke<WorktreeStatus>("worktree_status", { path }),

  removeWorktree: (repoId: string, path: string, force: boolean, deleteBranch: boolean) =>
    invoke<RemoveResult>("remove_worktree", { repoId, path, force, deleteBranch }),

  pruneWorktrees: (repoId: string) =>
    invoke<void>("prune_worktrees", { repoId }),
};
