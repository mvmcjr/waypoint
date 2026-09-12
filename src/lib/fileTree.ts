// Generic file-tree builder shared by the commit file list and StagingPanel.
// T only needs a `path` field; the rest of the payload is preserved on leaf nodes.

export type FileNode<T> = { kind: "file"; file: T };
export type DirNode<T>  = { kind: "dir";  name: string; path: string; children: TreeNode<T>[] };
export type TreeNode<T> = FileNode<T> | DirNode<T>;

export function buildFileTree<T extends { path: string }>(files: T[]): TreeNode<T>[] {
  const dirMap = new Map<string, DirNode<T>>();
  const roots: TreeNode<T>[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  function getOrCreateDir(parts: string[], depth: number): DirNode<T> {
    const path = parts.slice(0, depth).join("/");
    if (dirMap.has(path)) return dirMap.get(path)!;
    const node: DirNode<T> = { kind: "dir", name: parts[depth - 1], path, children: [] };
    dirMap.set(path, node);
    if (depth === 1) roots.push(node);
    else getOrCreateDir(parts, depth - 1).children.push(node);
    return node;
  }

  for (const file of sorted) {
    const parts = file.path.split("/");
    if (parts.length === 1) roots.push({ kind: "file", file });
    else getOrCreateDir(parts.slice(0, -1), parts.length - 1).children.push({ kind: "file", file });
  }

  function sort(nodes: TreeNode<T>[]): TreeNode<T>[] {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      if (a.kind === "dir" && b.kind === "dir") return a.name.localeCompare(b.name);
      if (a.kind === "file" && b.kind === "file") return a.file.path.localeCompare(b.file.path);
      return 0;
    });
    for (const n of nodes) if (n.kind === "dir") sort(n.children);
    return nodes;
  }

  return sort(roots);
}

/** Paths of every directory node — used to initialise expandedDirs. */
export function collectDirPaths<T>(nodes: TreeNode<T>[]): string[] {
  const paths: string[] = [];
  function collect(ns: TreeNode<T>[]) {
    for (const n of ns) {
      if (n.kind === "dir") { paths.push(n.path); collect(n.children); }
    }
  }
  collect(nodes);
  return paths;
}

/** Every ancestor directory path of a file path: "a/b/c.ts" → ["a", "a/b"]. */
export function ancestorDirs(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * Files in the order a file list displays them: as given in "path" view,
 * depth-first (dirs before files) in "tree" view. Prev/next file navigation
 * walks this order so it matches what the user sees.
 */
export function orderFiles<T extends { path: string }>(files: T[], view: "path" | "tree" | undefined): T[] {
  if (view !== "tree") return files;
  const out: T[] = [];
  function walk(nodes: TreeNode<T>[]) {
    for (const n of nodes) {
      if (n.kind === "file") out.push(n.file);
      else walk(n.children);
    }
  }
  walk(buildFileTree(files));
  return out;
}
