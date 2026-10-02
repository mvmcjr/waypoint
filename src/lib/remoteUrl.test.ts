import { describe, it, expect } from "vitest";
import { remoteWebUrl, remoteBranchWebUrl, splitRemoteBranch, trackingBranchWebUrl, trackingRefForBranch } from "./remoteUrl";

describe("remoteWebUrl", () => {
  it.each([
    ["https://github.com/owner/repo.git", "https://github.com/owner/repo"],
    ["https://github.com/owner/repo", "https://github.com/owner/repo"],
    ["https://github.com/owner/repo/", "https://github.com/owner/repo"],
    ["https://user:token@github.com/owner/repo.git", "https://github.com/owner/repo"],
    ["http://git.example.com:8080/team/repo.git", "http://git.example.com:8080/team/repo"],
    ["git@github.com:owner/repo.git", "https://github.com/owner/repo"],
    ["github.com:owner/repo", "https://github.com/owner/repo"],
    ["ssh://git@gitlab.com:2222/group/sub/repo.git", "https://gitlab.com/group/sub/repo"],
    ["git+ssh://git@bitbucket.org/team/repo.git", "https://bitbucket.org/team/repo"],
    ["git://git.kernel.org/pub/scm/git/git.git", "https://git.kernel.org/pub/scm/git/git"],
    ["git@ssh.dev.azure.com:v3/org/project/repo", "https://dev.azure.com/org/project/_git/repo"],
    ["https://org@dev.azure.com/org/project/_git/repo", "https://dev.azure.com/org/project/_git/repo"],
    ["org@vs-ssh.visualstudio.com:v3/org/project/repo", "https://org.visualstudio.com/project/_git/repo"],
    ["ssh://git@ssh.github.com:443/owner/repo.git", "https://github.com/owner/repo"],
    ["ssh://git@altssh.gitlab.com:443/group/repo.git", "https://gitlab.com/group/repo"],
    ["ssh://git@altssh.bitbucket.org:443/team/repo.git", "https://bitbucket.org/team/repo"],
    ["git@host.example:team/my repo#2.git", "https://host.example/team/my%20repo%232"],
    ["https://host.example/team/my%20repo.git", "https://host.example/team/my%20repo"],
    ["git@ssh.dev.azure.com:v3/org/My%20Project/repo", "https://dev.azure.com/org/My%20Project/_git/repo"],
    ["git@host.example:team/100%/repo.git", "https://host.example/team/100%25/repo"],
  ])("%s → %s", (input, expected) => {
    expect(remoteWebUrl(input)).toBe(expected);
  });

  it.each([
    "",
    "C:\\repos\\upstream",
    "C:/repos/upstream",
    "/srv/git/repo.git",
    "../sibling",
    "file:///srv/git/repo.git",
    "https://github.com/",
    "codecommit::us-east-1://repo",
    "ext::ssh -i key host %S 'foo/repo'",
  ])("returns null for non-web remote %j", (input) => {
    expect(remoteWebUrl(input)).toBeNull();
  });
});

describe("remoteBranchWebUrl", () => {
  it("uses each host's branch path", () => {
    expect(remoteBranchWebUrl("git@github.com:o/r.git", "feat/x")).toBe("https://github.com/o/r/tree/feat/x");
    expect(remoteBranchWebUrl("git@github.acme.com:o/r.git", "main")).toBe("https://github.acme.com/o/r/tree/main");
    expect(remoteBranchWebUrl("https://gitlab.com/g/r.git", "main")).toBe("https://gitlab.com/g/r/-/tree/main");
    expect(remoteBranchWebUrl("git@bitbucket.org:t/r.git", "main")).toBe("https://bitbucket.org/t/r/src/main");
    expect(remoteBranchWebUrl("https://codeberg.org/o/r.git", "main")).toBe("https://codeberg.org/o/r/src/branch/main");
    expect(remoteBranchWebUrl("git@ssh.dev.azure.com:v3/org/p/r", "feat/x")).toBe(
      "https://dev.azure.com/org/p/_git/r?version=GBfeat%2Fx",
    );
  });

  it("encodes branch segments but keeps slashes", () => {
    expect(remoteBranchWebUrl("git@github.com:o/r.git", "feat/a b#1")).toBe(
      "https://github.com/o/r/tree/feat/a%20b%231",
    );
  });

  it("falls back to the repo root for unknown hosts", () => {
    expect(remoteBranchWebUrl("git@git.example.com:o/r.git", "main")).toBe("https://git.example.com/o/r");
  });

  it("returns null when the remote has no web URL", () => {
    expect(remoteBranchWebUrl("/srv/git/repo.git", "main")).toBeNull();
  });
});

describe("splitRemoteBranch", () => {
  it("splits on the longest matching remote name", () => {
    expect(splitRemoteBranch("origin/feat/x", ["origin"])).toEqual({ remote: "origin", branch: "feat/x" });
    expect(splitRemoteBranch("team/a/main", ["team", "team/a"])).toEqual({ remote: "team/a", branch: "main" });
  });

  it("returns null when no remote matches", () => {
    expect(splitRemoteBranch("upstream/main", ["origin"])).toBeNull();
  });
});

describe("trackingBranchWebUrl", () => {
  const remotes = [
    { name: "origin", url: "git@github.com:me/repo.git" },
    { name: "local", url: "/srv/git/repo.git" },
  ];

  it("resolves the remote and opens the branch page", () => {
    expect(trackingBranchWebUrl("origin/feat/x", remotes)).toBe("https://github.com/me/repo/tree/feat/x");
  });

  it("returns null for unknown remotes or remotes without a web page", () => {
    expect(trackingBranchWebUrl("upstream/main", remotes)).toBeNull();
    expect(trackingBranchWebUrl("local/main", remotes)).toBeNull();
  });
});

describe("trackingRefForBranch", () => {
  it("prefers origin, then the first remote in order", () => {
    expect(trackingRefForBranch("main", ["upstream/main", "origin/main"], ["upstream", "origin"])).toBe("origin/main");
    expect(trackingRefForBranch("main", ["upstream/main", "fork/main"], ["fork", "upstream"])).toBe("fork/main");
  });

  it("matches whole remote names, including ones with slashes", () => {
    expect(trackingRefForBranch("a/main", ["team/a/main"], ["team"])).toBe("team/a/main");
    expect(trackingRefForBranch("main", ["team/a/main"], ["team/a"])).toBe("team/a/main");
    expect(trackingRefForBranch("a/main", ["team/a/main"], ["team/a"])).toBeNull();
  });

  it("returns null when the branch is on no remote", () => {
    expect(trackingRefForBranch("feat", ["origin/main"], ["origin"])).toBeNull();
  });
});
