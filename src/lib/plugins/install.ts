import { ipc } from "@/lib/ipc";
import { validateManifest } from "./registry";
import type { InstalledPlugin } from "./types";

/** Fetch a raw file from a GitHub repo at a given ref. Returns null on 404. */
async function fetchRaw(owner: string, repo: string, ref: string, path: string): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub fetch failed (${res.status}) for ${path}`);
  return res.text();
}

/** Refs to try when none is specified (GitHub raw needs an explicit ref). */
const DEFAULT_REFS = ["main", "master"];

async function installFromGitHub(owner: string, repo: string, ref?: string): Promise<InstalledPlugin> {
  const refsToTry = ref ? [ref] : DEFAULT_REFS;

  let resolvedRef: string | null = null;
  let manifestText: string | null = null;
  for (const r of refsToTry) {
    manifestText = await fetchRaw(owner, repo, r, "waypoint.plugin.json");
    if (manifestText !== null) {
      resolvedRef = r;
      break;
    }
  }
  if (manifestText === null || resolvedRef === null) {
    throw new Error(
      `No waypoint.plugin.json found in ${owner}/${repo} (tried: ${refsToTry.join(", ")}).`,
    );
  }

  const manifest = validateManifest(JSON.parse(manifestText));
  const code = await fetchRaw(owner, repo, resolvedRef, manifest.entry);
  if (code === null) {
    throw new Error(`Entry "${manifest.entry}" not found in ${owner}/${repo}@${resolvedRef}.`);
  }

  return {
    id: `github:${owner}/${repo}`,
    source: `github:${owner}/${repo}${ref ? `@${ref}` : ""}`,
    manifest,
    code,
    enabled: true,
  };
}

async function installFromLocal(path: string): Promise<InstalledPlugin> {
  const { manifest: manifestText, code } = await ipc.readLocalPlugin(path);
  const manifest = validateManifest(JSON.parse(manifestText));
  return {
    id: `local:${path}`,
    source: `local:${path}`,
    manifest,
    code,
    enabled: true,
  };
}

/**
 * Resolve an install source to an InstalledPlugin (validated, not yet persisted).
 * Accepts:
 *   - "owner/repo" or "owner/repo@ref"
 *   - a GitHub URL "https://github.com/owner/repo"
 *   - an absolute local path (contains a slash/backslash and is not owner/repo form)
 */
export async function installPlugin(input: string): Promise<InstalledPlugin> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a GitHub repo (owner/repo) or a local folder path.");

  // github.com URL
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (urlMatch) {
    return installFromGitHub(urlMatch[1], urlMatch[2].replace(/\.git$/, ""));
  }

  // owner/repo[@ref] — exactly one slash, no path separators beyond it, no spaces
  const shorthand = trimmed.match(/^([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?$/);
  if (shorthand && !trimmed.includes("\\")) {
    return installFromGitHub(shorthand[1], shorthand[2], shorthand[3]);
  }

  // Otherwise treat as a local folder path.
  return installFromLocal(trimmed);
}
