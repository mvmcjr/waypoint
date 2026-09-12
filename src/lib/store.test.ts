import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./store";
import type { PositionedCommit } from "./ipc";

const REPO1 = "/repos/foo";
const REPO2 = "/repos/bar";

const fakeCommit = { commit: { oid: "abc123" } } as PositionedCommit;

function seed() {
  useStore.setState({
    tabs: [
      { id: REPO1, path: REPO1, label: "foo" },
      { id: REPO2, path: REPO2, label: "bar" },
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
    useStore.setState({ tabs: [{ id: REPO1, path: REPO1, label: "foo" }], activeTabId: REPO1 });
    useStore.getState().closeTab(REPO1);

    const s = useStore.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.activeTabId).toBeNull();
  });
});
