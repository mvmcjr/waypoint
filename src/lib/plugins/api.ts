import { ipc } from "@/lib/ipc";
import type { InputField, PluginContext } from "./types";

export type ApiHandlers = Record<string, (...args: any[]) => unknown | Promise<unknown>>;

/**
 * Build the host api exposed to plugins for a given context. Git methods map to
 * existing ipc wrappers; `prompt`/`notify`/`fetch` are wired by the caller.
 */
export function buildApiHandlers(
  ctx: PluginContext,
  extras: {
    prompt: (fields: InputField[]) => Promise<Record<string, unknown> | null>;
    notify: (msg: string) => void;
  },
): ApiHandlers {
  const repoId = ctx.repoId;
  return {
    // ── reads ──────────────────────────────────────────────
    listRefs: () => ipc.listRefs(repoId),
    getHead: () => ipc.getHeadInfo(repoId),
    listStatus: () => ipc.listStatus(repoId),
    getCommit: (oid: string) => ipc.getCommit(repoId, oid),

    // ── writes ─────────────────────────────────────────────
    createBranch: (name: string, oid: string, checkout = false) =>
      ipc.createBranchAt(repoId, name, oid, checkout),
    createTag: (name: string, oid: string, message = "") =>
      ipc.createTag(repoId, name, oid, message),
    checkoutBranch: (name: string, force = false) => ipc.checkoutBranch(repoId, name, force),
    checkoutCommit: (oid: string, force = false) => ipc.checkoutCommit(repoId, oid, force),
    commit: (message: string) => ipc.doCommit(repoId, message),
    push: (remote: string, branch: string, force = false) =>
      ipc.pushBranch(repoId, remote, branch, force),
    merge: (oid: string, label = "") => ipc.mergeCommit(repoId, oid, label),
    rebase: (ontoOid: string) => ipc.rebaseOnto(repoId, ontoOid),
    reset: (oid: string, kind: "soft" | "mixed" | "hard") => ipc.resetHead(repoId, oid, kind),
    cherryPick: (oid: string) => ipc.cherryPick(repoId, oid),
    squash: (oids: string[], message: string) => ipc.squashCommits(repoId, oids, message),

    // ── interaction / io ───────────────────────────────────
    prompt: (fields: InputField[]) => extras.prompt(fields),
    notify: (msg: string) => extras.notify(String(msg)),
    fetch: async (url: string, init?: RequestInit) => {
      const res = await fetch(url, init);
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.status, ok: res.ok, text, json };
    },
  };
}
