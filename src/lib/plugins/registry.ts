import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import {
  ALL_SURFACES,
  type InstalledPlugin,
  type PluginManifest,
  type Surface,
  type SurfaceCommand,
} from "./types";

const STORE_FILE = "plugins.json";
const STORE_KEY = "installed_plugins";

async function getStore() {
  return load(STORE_FILE, { defaults: {} });
}

/**
 * Validate an unknown value as a PluginManifest, returning a normalized manifest
 * or throwing a descriptive error. Hand-rolled (no schema lib) — keep it strict
 * enough to catch obvious authoring mistakes.
 */
export function validateManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== "object") throw new Error("Manifest is not an object.");
  const m = raw as Record<string, unknown>;

  if (typeof m.name !== "string" || !m.name.trim()) {
    throw new Error("Manifest is missing a non-empty \"name\".");
  }
  const entry = typeof m.entry === "string" && m.entry.trim() ? m.entry : "plugin.js";

  const contributes = (m.contributes ?? {}) as Record<string, unknown>;
  const rawCommands = contributes.commands;
  if (!Array.isArray(rawCommands) || rawCommands.length === 0) {
    throw new Error("Manifest must declare at least one command in contributes.commands.");
  }

  const commands = rawCommands.map((c, i) => {
    const cmd = c as Record<string, unknown>;
    if (typeof cmd.id !== "string" || !cmd.id.trim()) {
      throw new Error(`Command #${i + 1} is missing an "id".`);
    }
    if (typeof cmd.title !== "string" || !cmd.title.trim()) {
      throw new Error(`Command "${cmd.id}" is missing a "title".`);
    }
    const surfaces = Array.isArray(cmd.surfaces) ? (cmd.surfaces as Surface[]) : [];
    const bad = surfaces.filter((s) => !ALL_SURFACES.includes(s));
    if (surfaces.length === 0) {
      throw new Error(`Command "${cmd.id}" must declare at least one surface.`);
    }
    if (bad.length > 0) {
      throw new Error(`Command "${cmd.id}" has unknown surface(s): ${bad.join(", ")}.`);
    }
    return {
      id: cmd.id,
      title: cmd.title,
      surfaces,
      icon: typeof cmd.icon === "string" ? cmd.icon : undefined,
      inputs: Array.isArray(cmd.inputs) ? (cmd.inputs as PluginManifest["contributes"]["commands"][number]["inputs"]) : undefined,
    };
  });

  return {
    name: m.name,
    version: typeof m.version === "string" ? m.version : undefined,
    description: typeof m.description === "string" ? m.description : undefined,
    entry,
    contributes: { commands },
  };
}

interface PluginRegistryState {
  plugins: InstalledPlugin[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Add or replace (by id) a plugin, then persist. */
  upsert: (plugin: InstalledPlugin) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
}

async function persist(plugins: InstalledPlugin[]) {
  const store = await getStore();
  await store.set(STORE_KEY, plugins);
}

export const usePluginRegistry = create<PluginRegistryState>((set, get) => ({
  plugins: [],
  loaded: false,

  load: async () => {
    const store = await getStore();
    const plugins = (await store.get<InstalledPlugin[]>(STORE_KEY)) ?? [];
    set({ plugins, loaded: true });
  },

  upsert: async (plugin) => {
    const next = [...get().plugins.filter((p) => p.id !== plugin.id), plugin];
    set({ plugins: next });
    await persist(next);
  },

  remove: async (id) => {
    const next = get().plugins.filter((p) => p.id !== id);
    set({ plugins: next });
    await persist(next);
  },

  setEnabled: async (id, enabled) => {
    const next = get().plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
    set({ plugins: next });
    await persist(next);
  },
}));

/** Flatten enabled plugins' commands for a given surface. Pure — for use in selectors/components. */
export function commandsForSurface(plugins: InstalledPlugin[], surface: Surface): SurfaceCommand[] {
  const out: SurfaceCommand[] = [];
  for (const p of plugins) {
    if (!p.enabled) continue;
    for (const command of p.manifest.contributes.commands) {
      if (command.surfaces.includes(surface)) out.push({ pluginId: p.id, command });
    }
  }
  return out;
}
