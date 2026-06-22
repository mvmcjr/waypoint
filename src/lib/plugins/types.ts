// Plugin system types. A plugin is a small JS package (local folder or GitHub
// repo) described by a `waypoint.plugin.json` manifest plus an entry JS module
// that exports `commands` keyed by command id.

/** Where a plugin command can be surfaced in the UI. */
export type Surface =
  | "commandPalette"
  | "commitContextMenu"
  | "branchContextMenu"
  | "toolbar";

export const ALL_SURFACES: Surface[] = [
  "commandPalette",
  "commitContextMenu",
  "branchContextMenu",
  "toolbar",
];

/** A user-input field collected before a command runs (or via api.prompt). */
export interface InputField {
  id: string;
  label?: string;
  type: "text" | "select" | "confirm";
  /** For type "select": the choices. */
  options?: string[];
  /** Default value (string for text/select, boolean for confirm). */
  default?: string | boolean;
  placeholder?: string;
}

export interface CommandContribution {
  id: string;
  title: string;
  surfaces: Surface[];
  /** Optional lucide-react icon name (e.g. "Tag"). */
  icon?: string;
  /** Inputs collected and passed to the handler as `inputs`. */
  inputs?: InputField[];
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** Relative path to the entry JS module (default "plugin.js"). */
  entry: string;
  contributes: {
    commands: CommandContribution[];
  };
}

/** A plugin as persisted in the store. */
export interface InstalledPlugin {
  /** Stable id — derived from the source (e.g. "github:owner/repo" or "local:<path>"). */
  id: string;
  /** Human-readable source descriptor for display + reinstall. */
  source: string;
  manifest: PluginManifest;
  /** Entry module source code (ESM), fetched at install time. */
  code: string;
  enabled: boolean;
}

/** Runtime context handed to a command handler. */
export interface PluginContext {
  repoId: string;
  headOid: string | null;
  headBranch: string | null;
  surface: Surface;
  /** Set when invoked from a commit context menu. */
  commitOid?: string;
  commitSummary?: string;
  /** Set when invoked from a branch context menu. */
  branchName?: string;
}

/** A command paired with the plugin that owns it — used by surfaces. */
export interface SurfaceCommand {
  pluginId: string;
  command: CommandContribution;
}
