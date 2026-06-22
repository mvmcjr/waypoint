import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateManifest, commandsForSurface } from "./registry";
import { buildApiHandlers } from "./api";
import { ipc } from "@/lib/ipc";
import type { InstalledPlugin, PluginContext } from "./types";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listRefs: vi.fn(),
    createBranchAt: vi.fn(),
    pushBranch: vi.fn(),
    squashCommits: vi.fn(),
  },
}));

describe("validateManifest", () => {
  const valid = {
    name: "release-tools",
    entry: "plugin.js",
    contributes: { commands: [{ id: "create-release", title: "Create Release", surfaces: ["toolbar"] }] },
  };

  it("accepts a valid manifest", () => {
    const m = validateManifest(valid);
    expect(m.name).toBe("release-tools");
    expect(m.contributes.commands).toHaveLength(1);
  });

  it("defaults entry to plugin.js when omitted", () => {
    const { entry, ...noEntry } = valid;
    void entry;
    expect(validateManifest(noEntry).entry).toBe("plugin.js");
  });

  it("rejects a missing name", () => {
    expect(() => validateManifest({ ...valid, name: "" })).toThrow(/name/i);
  });

  it("rejects when there are no commands", () => {
    expect(() => validateManifest({ ...valid, contributes: { commands: [] } })).toThrow(/at least one command/i);
  });

  it("rejects an unknown surface", () => {
    const bad = { ...valid, contributes: { commands: [{ id: "x", title: "X", surfaces: ["nope"] }] } };
    expect(() => validateManifest(bad)).toThrow(/unknown surface/i);
  });

  it("rejects a command with no surfaces", () => {
    const bad = { ...valid, contributes: { commands: [{ id: "x", title: "X", surfaces: [] }] } };
    expect(() => validateManifest(bad)).toThrow(/at least one surface/i);
  });
});

describe("commandsForSurface", () => {
  function plugin(id: string, enabled: boolean, surfaces: any[]): InstalledPlugin {
    return {
      id,
      source: id,
      enabled,
      code: "",
      manifest: {
        name: id,
        entry: "plugin.js",
        contributes: { commands: [{ id: `${id}-cmd`, title: id, surfaces }] },
      },
    };
  }

  it("includes only enabled plugins matching the surface", () => {
    const plugins = [
      plugin("a", true, ["toolbar", "commandPalette"]),
      plugin("b", false, ["toolbar"]),
      plugin("c", true, ["commitContextMenu"]),
    ];
    const toolbar = commandsForSurface(plugins, "toolbar");
    expect(toolbar.map((c) => c.pluginId)).toEqual(["a"]);

    const palette = commandsForSurface(plugins, "commandPalette");
    expect(palette.map((c) => c.pluginId)).toEqual(["a"]);

    const commit = commandsForSurface(plugins, "commitContextMenu");
    expect(commit.map((c) => c.pluginId)).toEqual(["c"]);
  });
});

describe("buildApiHandlers", () => {
  const ctx: PluginContext = { repoId: "repo1", headOid: "deadbeef", headBranch: "main", surface: "toolbar" };
  const extras = { prompt: vi.fn(), notify: vi.fn() };

  beforeEach(() => vi.clearAllMocks());

  it("maps createBranch to ipc.createBranchAt with the context repoId", async () => {
    const api = buildApiHandlers(ctx, extras);
    await api.createBranch("release/v1.0.1", "deadbeef", true);
    expect(ipc.createBranchAt).toHaveBeenCalledWith("repo1", "release/v1.0.1", "deadbeef", true);
  });

  it("defaults createBranch checkout to false", async () => {
    const api = buildApiHandlers(ctx, extras);
    await api.createBranch("x", "oid");
    expect(ipc.createBranchAt).toHaveBeenCalledWith("repo1", "x", "oid", false);
  });

  it("maps listRefs to ipc.listRefs", async () => {
    const api = buildApiHandlers(ctx, extras);
    await api.listRefs();
    expect(ipc.listRefs).toHaveBeenCalledWith("repo1");
  });

  it("routes prompt and notify to the provided extras", () => {
    const api = buildApiHandlers(ctx, extras);
    api.prompt([{ id: "x", type: "text" }]);
    api.notify("hi");
    expect(extras.prompt).toHaveBeenCalled();
    expect(extras.notify).toHaveBeenCalledWith("hi");
  });
});
