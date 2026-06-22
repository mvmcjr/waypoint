// example-plugin — a reference plugin for Waypoint.
//
// Demonstrates the three handler arguments (ctx, api, inputs), every surface,
// declared inputs, a write, the runtime prompt, network fetch, and notify.
//
// The entry module is evaluated in an isolated Web Worker with NO module
// resolver — keep everything self-contained (no `import` of bare packages).
// See docs/plugins.md for the full API reference.

/** Turn an arbitrary string into a git-friendly slug. */
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const commands = {
  // ── Commit context menu: create a branch at the right-clicked commit ──────
  // Uses ctx.commitOid (set for the commitContextMenu surface) and declared
  // inputs (a text field + a confirm checkbox).
  "branch-from-commit": async (ctx, api, inputs) => {
    const name = String(inputs.name || "").trim();
    if (!name) throw new Error("Enter a branch name.");
    if (!ctx.commitOid) throw new Error("No commit in context.");

    await api.createBranch(name, ctx.commitOid, Boolean(inputs.checkout));
    return `Created branch "${name}" at ${ctx.commitOid.slice(0, 8)}`;
  },

  // ── Branch context menu: read-only, demonstrates ctx.branchName + notify ──
  "show-branch-slug": async (ctx, api) => {
    if (!ctx.branchName) throw new Error("No branch in context.");
    api.notify(`${ctx.branchName}  →  ${slugify(ctx.branchName)}`);
  },

  // ── Palette / toolbar: network fetch + notify. Also shows api.prompt, which
  // collects input at runtime (instead of declaring it in the manifest). ─────
  "github-rate-limit": async (_ctx, api) => {
    const answers = await api.prompt([
      { id: "token", type: "text", label: "GitHub token (optional, for higher limits)" },
    ]);
    if (answers === null) return; // user cancelled

    const init = answers.token
      ? { headers: { Authorization: `Bearer ${answers.token}` } }
      : undefined;

    const res = await api.fetch("https://api.github.com/rate_limit", init);
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);

    const rate = res.json?.rate ?? {};
    return `GitHub API: ${rate.remaining ?? "?"} / ${rate.limit ?? "?"} calls remaining`;
  },
};
