// Turns a git remote URL (https, ssh, scp-like `git@host:path`, git://) into
// the hosting service's web page for that repo, so "Open in browser" works for
// GitHub, GitLab, Bitbucket, Azure DevOps, Gitea/Forgejo and most self-hosted
// setups. Local-path and file:// remotes have no web page and yield null.

interface WebRepo {
  /** e.g. "https://github.com/owner/repo" */
  base: string;
  /** Lowercased web host, including a port only for http(s) remotes. */
  host: string;
}

const URL_SCHEMES = new Set(["http", "https", "ssh", "git", "git+ssh", "ssh+git"]);

// SSH-over-443 endpoints whose web UI lives on the main domain.
const SSH_WEB_HOSTS: Record<string, string> = {
  "ssh.github.com": "github.com",
  "altssh.gitlab.com": "gitlab.com",
  "altssh.bitbucket.org": "bitbucket.org",
};

function encodePathSegment(segment: string): string {
  return segment
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((part, i) => (i % 2 ? part : encodeURIComponent(part)))
    .join("");
}

function parseRemote(url: string): WebRepo | null {
  const s = url.trim();
  if (!s) return null;

  let protocol: string;
  let host: string;
  let path: string;

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (!URL_SCHEMES.has(proto)) return null;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    // An http(s) remote's port is also its web port; an ssh/git port isn't.
    protocol = proto === "http" || proto === "https" ? proto : "https";
    host = protocol === proto ? u.host : u.hostname;
    path = u.pathname;
  } else {
    // scp-like `[user@]host:path`. A one-letter "host" is a Windows drive
    // letter (C:\repo), which git also treats as a local path.
    const m = /^(?:[^@/\\]+@)?([^:/\\]+):(.+)$/.exec(s);
    if (!m || m[1].length < 2) return null;
    // `transport::address` is a remote-helper URL (codecommit::, ext::…).
    if (m[2].startsWith(":")) return null;
    protocol = "https";
    host = m[1];
    // Unlike URL.pathname, an scp-like path may arrive unencoded — or, as in
    // Azure's `My%20Project`, already encoded. Keep %XX escapes as they are.
    path = m[2].split("/").map(encodePathSegment).join("/");
  }

  host = host.toLowerCase();
  host = SSH_WEB_HOSTS[host] ?? host;
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !path) return null;

  // Azure DevOps ssh remotes don't mirror the web path:
  //   ssh.dev.azure.com:v3/org/project/repo       → dev.azure.com/org/project/_git/repo
  //   vs-ssh.visualstudio.com:v3/org/project/repo → org.visualstudio.com/project/_git/repo
  const azure = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (azure && host === "ssh.dev.azure.com") {
    host = "dev.azure.com";
    path = `${azure[1]}/${azure[2]}/_git/${azure[3]}`;
  } else if (azure && host === "vs-ssh.visualstudio.com") {
    host = `${azure[1]}.visualstudio.com`;
    path = `${azure[2]}/_git/${azure[3]}`;
  }

  return { base: `${protocol}://${host}/${path}`, host };
}

/** Web page for the repo behind a git remote URL, or null if it has none. */
export function remoteWebUrl(url: string): string | null {
  return parseRemote(url)?.base ?? null;
}

/**
 * Web page for `branch` on the repo behind a git remote URL. Hosts whose
 * branch URL scheme isn't known get the repo root instead.
 */
export function remoteBranchWebUrl(url: string, branch: string): string | null {
  const repo = parseRemote(url);
  if (!repo) return null;
  const { base, host } = repo;
  const b = branch.split("/").map(encodeURIComponent).join("/");

  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    return `${base}?version=GB${encodeURIComponent(branch)}`;
  }
  if (host.includes("github")) return `${base}/tree/${b}`;
  if (host.includes("gitlab")) return `${base}/-/tree/${b}`;
  if (host === "bitbucket.org") return `${base}/src/${b}`;
  if (host === "codeberg.org" || host.includes("gitea") || host.includes("forgejo")) {
    return `${base}/src/branch/${b}`;
  }
  return base;
}

/**
 * Splits a remote-tracking shorthand ("origin/feature/x") into its remote and
 * branch. Remote names may contain slashes, so the longest match wins.
 */
export function splitRemoteBranch(
  shorthand: string,
  remoteNames: string[],
): { remote: string; branch: string } | null {
  const remote = remoteNames
    .filter((r) => shorthand.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, branch: shorthand.slice(remote.length + 1) } : null;
}

/**
 * Web page for a remote-tracking branch ("origin/feature") given the repo's
 * remotes, or null when the remote is unknown or has no web page.
 */
export function trackingBranchWebUrl(
  remoteBranch: string,
  remotes: { name: string; url: string }[],
): string | null {
  const split = splitRemoteBranch(remoteBranch, remotes.map((r) => r.name));
  if (!split) return null;
  const remote = remotes.find((r) => r.name === split.remote)!;
  return remoteBranchWebUrl(remote.url, split.branch);
}

/**
 * Remote-tracking ref ("origin/main") for a local branch of the same name,
 * preferring origin, then the remotes in their listed order. Matches whole
 * remote names, so remotes containing slashes resolve correctly.
 */
export function trackingRefForBranch(
  branch: string,
  remoteBranches: string[],
  remoteNames: string[],
): string | null {
  const ordered = [...remoteNames].sort((a, b) => (b === "origin" ? 1 : 0) - (a === "origin" ? 1 : 0));
  for (const remote of ordered) {
    const ref = `${remote}/${branch}`;
    if (remoteBranches.includes(ref)) return ref;
  }
  return null;
}
