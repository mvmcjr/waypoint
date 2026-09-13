import { describe, it, expect, beforeEach } from "vitest";
import { useStore, tabLabels } from "./store";
import type { PositionedCommit } from "./ipc";

const REPO1 = "/repos/foo";
const REPO2 = "/repos/bar";

const fakeCommit = { commit: { oid: "abc123" } } as PositionedCommit;

function seed() {
  useStore.setState({
    tabs: [
      { id: REPO1, path: REPO1, label: "foo", mainPath: null },
      { id: REPO2, path: REPO2, label: "bar", mainPath: null },
    ],
    activeTabId: REPO1,
    commits: [fakeCommit],
    selectedOid: "abc123",
    settingsOpen: false,
  });
}

describe("useStore – switchTab", () => {
  beforeEach(seed);

  it("is a no-op when target is already the active tab (commits/selectedOid preserved)", () => {
    useStore.getState().switchTab(REPO1);

    const s = useStore.getState();
    expect(s.activeTabId).toBe(REPO1);
    // BLANK_VIEW must NOT have been applied
    expect(s.commits).toHaveLength(1);
    expect(s.selectedOid).toBe("abc123");
  });

  it("resets BLANK_VIEW when switching to a different tab", () => {
    useStore.getState().switchTab(REPO2);

    const s = useStore.getState();
    expect(s.activeTabId).toBe(REPO2);
    expect(s.commits).toHaveLength(0);
    expect(s.selectedOid).toBeNull();
  });
});

describe("useStore – openTab", () => {
  beforeEach(seed);

  it("is a no-op when the tab is already active", () => {
    useStore.getState().openTab(REPO1, REPO1);

    const s = useStore.getState();
    expect(s.activeTabId).toBe(REPO1);
    expect(s.commits).toHaveLength(1); // NOT cleared
    expect(s.selectedOid).toBe("abc123");
  });

  it("switches to an existing (inactive) tab and clears state", () => {
    useStore.getState().openTab(REPO2, REPO2);

    const s = useStore.getState();
    expect(s.activeTabId).toBe(REPO2);
    expect(s.tabs).toHaveLength(2); // no duplicate added
    expect(s.commits).toHaveLength(0);
  });

  it("opens a new tab for an unknown path", () => {
    const REPO3 = "/repos/baz";
    useStore.getState().openTab(REPO3, REPO3);

    const s = useStore.getState();
    expect(s.activeTabId).toBe(REPO3);
    expect(s.tabs).toHaveLength(3);
    expect(s.commits).toHaveLength(0);
  });

  it("bumps openSeq on every openTab call, including a no-op reopen of the already-active tab", () => {
    const before = useStore.getState().openSeq;

    // Reopening the currently-active tab (e.g. the same worktree path, whose
    // folder came back after being reported removed) is a no-op for
    // activeTabId/tabs, but RepoView needs a signal that a (re)open happened
    // — that's what openSeq is for.
    useStore.getState().openTab(REPO1, REPO1);
    expect(useStore.getState().openSeq).toBe(before + 1);

    useStore.getState().openTab(REPO2, REPO2); // switch to an existing tab
    expect(useStore.getState().openSeq).toBe(before + 2);

    useStore.getState().openTab("/repos/baz", "/repos/baz"); // brand-new tab
    expect(useStore.getState().openSeq).toBe(before + 3);
  });
});

describe("useStore – closeTab", () => {
  beforeEach(seed);

  it("removes the tab and activates the previous one", () => {
    useStore.getState().switchTab(REPO2); // make REPO2 active
    useStore.getState().closeTab(REPO2);

    const s = useStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(REPO1);
  });

  it("clears activeTabId when the last tab is closed", () => {
    useStore.setState({ tabs: [{ id: REPO1, path: REPO1, label: "foo", mainPath: null }], activeTabId: REPO1 });
    useStore.getState().closeTab(REPO1);

    const s = useStore.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.activeTabId).toBeNull();
  });
});

describe("tabLabels", () => {
  it("disambiguates colliding worktree names by their main repo", () => {
    const labels = tabLabels([
      { id: "E:\\a\\.worktrees\\fix", path: "E:\\a\\.worktrees\\fix", label: "fix", mainPath: "E:\\alugar" },
      { id: "E:\\w\\.worktrees\\fix", path: "E:\\w\\.worktrees\\fix", label: "fix", mainPath: "E:\\waypoint" },
      { id: "E:\\other", path: "E:\\other", label: "other", mainPath: null },
    ]);
    expect(labels.get("E:\\a\\.worktrees\\fix")).toBe("fix · alugar");
    expect(labels.get("E:\\w\\.worktrees\\fix")).toBe("fix · waypoint");
    expect(labels.get("E:\\other")).toBe("other");
  });

  it("leaves non-colliding labels untouched", () => {
    const labels = tabLabels([
      { id: "E:\\a", path: "E:\\a", label: "a", mainPath: null },
      { id: "E:\\b", path: "E:\\b", label: "b", mainPath: "E:\\main" },
    ]);
    expect(labels.get("E:\\a")).toBe("a");
    expect(labels.get("E:\\b")).toBe("b");
  });

  it("disambiguates colliding non-worktree tabs by the parent folder of their path", () => {
    const labels = tabLabels([
      { id: "E:\\repos\\foo\\proj", path: "E:\\repos\\foo\\proj", label: "proj", mainPath: null },
      { id: "E:\\repos\\bar\\proj", path: "E:\\repos\\bar\\proj", label: "proj", mainPath: null },
    ]);
    expect(labels.get("E:\\repos\\foo\\proj")).toBe("proj · foo");
    expect(labels.get("E:\\repos\\bar\\proj")).toBe("proj · bar");
  });
});

describe("useStore – openTab mainPath", () => {
  beforeEach(seed);

  it("stores the given mainPath on a new tab", () => {
    useStore.getState().openTab("a", "a", "m");
    const tab = useStore.getState().tabs.find((t) => t.id === "a")!;
    expect(tab.mainPath).toBe("m");
  });

  it("defaults mainPath to null when omitted", () => {
    useStore.getState().openTab("a", "a");
    const tab = useStore.getState().tabs.find((t) => t.id === "a")!;
    expect(tab.mainPath).toBeNull();
  });
});
