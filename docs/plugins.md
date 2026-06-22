# Plugins

Waypoint can be extended with plugins — small JavaScript packages that add
custom commands to the command palette, commit/branch context menus, and the
toolbar. A plugin is just a folder (local, or a GitHub repo) containing a
manifest and an entry script.

> **Trust.** Plugins run with full access to Waypoint's repository actions and
> the network. There is no sandboxed permission model — installing a plugin is
> your responsibility. Only install plugins you trust, and you can disable or
> remove any plugin at any time in **Settings → Plugins**.

## Anatomy of a plugin

```
my-plugin/
├── waypoint.plugin.json   # manifest: metadata + contributed commands
└── plugin.js              # entry module: exports the command handlers
```

### `waypoint.plugin.json`

```json
{
  "name": "release-tools",
  "version": "1.0.0",
  "description": "Create the next versioned release branch.",
  "entry": "plugin.js",
  "contributes": {
    "commands": [
      {
        "id": "create-release",
        "title": "Create Release",
        "icon": "Tag",
        "surfaces": ["commandPalette", "branchContextMenu", "toolbar"],
        "inputs": [
          { "id": "bump", "type": "select", "label": "Version bump",
            "options": ["patch", "minor", "major"], "default": "patch" }
        ]
      }
    ]
  }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Display name. |
| `version` | no | Shown in Settings. |
| `description` | no | Shown in Settings. |
| `entry` | no | Entry module path. Defaults to `plugin.js`. |
| `contributes.commands` | yes | At least one command. |

Each command:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Unique within the plugin; the handler key in `plugin.js`. |
| `title` | yes | Menu / palette label. |
| `surfaces` | yes | Where it appears (see below). At least one. |
| `icon` | no | Reserved for future icon mapping. |
| `inputs` | no | Fields collected from the user before the handler runs. |

#### Surfaces

| Surface | Appears in | Extra context |
| --- | --- | --- |
| `commandPalette` | Ctrl/Cmd-Shift-P palette | — |
| `commitContextMenu` | right-click a commit | `ctx.commitOid`, `ctx.commitSummary` |
| `branchContextMenu` | right-click a branch (sidebar or badge) | `ctx.branchName` |
| `toolbar` | repo toolbar header | — |

#### Inputs

Collected into the `inputs` object passed to the handler.

| `type` | Renders | Value |
| --- | --- | --- |
| `text` | text field | `string` |
| `select` | dropdown (`options`) | `string` |
| `confirm` | checkbox | `boolean` |

Each input takes `id`, optional `label`, optional `default`, and (for `select`)
`options`.

### `plugin.js`

An ES module that exports `commands`, an object keyed by command `id`. Each
handler receives `(ctx, api, inputs)` and may be async. A returned string is
shown as the success toast.

```js
export const commands = {
  "create-release": async (ctx, api, inputs) => {
    // ...do work via api...
    return "Created release/v1.2.3";   // optional success message
  },
};
```

> **Self-contained only.** The entry module is evaluated in an isolated Web
> Worker with no module resolver — `import` of bare packages (e.g.
> `import semver from "semver"`) will fail. Inline whatever you need. Each run
> has a 30-second timeout, after which the plugin is terminated.

## The `ctx` object

| Field | Type | Notes |
| --- | --- | --- |
| `repoId` | string | Active repository. |
| `headOid` | string \| null | Current HEAD commit. |
| `headBranch` | string \| null | Current branch (null when detached). |
| `surface` | string | Which surface invoked the command. |
| `commitOid` | string? | Set from `commitContextMenu`. |
| `commitSummary` | string? | Set from `commitContextMenu`. |
| `branchName` | string? | Set from `branchContextMenu`. |

## The `api` object

All methods are async (return a Promise). Git methods operate on `ctx.repoId`.

### Reads

| Method | Returns |
| --- | --- |
| `listRefs()` | `RefInfo[]` — each `{ shorthand, kind, target_oid, is_head, is_pushed, name }`. |
| `getHead()` | `{ oid, branch }`. |
| `getCommit(oid)` | `{ oid, summary, body, author_name, author_email, timestamp, parent_oids }`. |
| `listStatus()` | working-dir file statuses. |

### Writes

| Method | Effect |
| --- | --- |
| `createBranch(name, oid, checkout = false)` | Create a branch at `oid`; optionally check it out. |
| `createTag(name, oid, message = "")` | Create a tag (annotated when `message` is set). |
| `checkoutBranch(name, force = false)` | Check out a local branch. |
| `checkoutCommit(oid, force = false)` | Detached checkout. |
| `commit(message)` | Commit the staged index. |
| `push(remote, branch, force = false)` | Push a branch. |
| `merge(oid, label = "")` | Merge a commit into the current branch. |
| `rebase(ontoOid)` | Rebase the current branch onto a commit. |
| `reset(oid, kind)` | `kind` is `"soft" \| "mixed" \| "hard"`. |
| `cherryPick(oid)` | Cherry-pick a commit. |
| `squash(oids, message)` | Squash a contiguous range into one commit. |

Write methods surface their normal Git errors (e.g. a rejected push) as the
plugin's error toast.

### Interaction & I/O

| Method | Notes |
| --- | --- |
| `prompt(fields)` | Open an input dialog at runtime; resolves to a values object, or `null` if cancelled. `fields` use the same shape as manifest `inputs`. |
| `notify(message)` | Show a toast. |
| `fetch(url, init?)` | HTTP request; resolves to `{ status, ok, text, json }` (`json` is `undefined` if the body isn't JSON). |

After a command finishes successfully, Waypoint refreshes the repo views so new
branches/tags/commits appear immediately.

## Installing

**Settings → Plugins**, then either:

- **GitHub** — enter `owner/repo` (or `owner/repo@branch`, or a `github.com`
  URL). The manifest + entry are fetched from `raw.githubusercontent.com`
  (tries `main` then `master` when no ref is given).
- **Local folder** — click **Folder…** and pick a directory containing
  `waypoint.plugin.json`. Handy while developing.

Use the **↻** button to reinstall/update a plugin from its source, the toggle
to enable/disable it, and the trash icon to remove it.

## Examples

### Create a release branch (full example)

See [`example-plugin/`](../example-plugin) and
[`scripts/fixtures/plugins/release-tools/`](../scripts/fixtures/plugins/release-tools).

### Tag a commit (commit context menu)

```json
{
  "name": "tagger",
  "entry": "plugin.js",
  "contributes": {
    "commands": [{
      "id": "tag-commit",
      "title": "Tag this commit…",
      "surfaces": ["commitContextMenu"],
      "inputs": [{ "id": "name", "type": "text", "label": "Tag name" }]
    }]
  }
}
```

```js
export const commands = {
  "tag-commit": async (ctx, api, inputs) => {
    if (!inputs.name) throw new Error("Tag name required.");
    await api.createTag(inputs.name, ctx.commitOid);
    return `Tagged ${ctx.commitOid.slice(0, 8)} as ${inputs.name}`;
  },
};
```

### Call an HTTP API (network + notify)

```js
export const commands = {
  "rate-limit": async (_ctx, api) => {
    const res = await api.fetch("https://api.github.com/rate_limit");
    const remaining = res.json?.rate?.remaining ?? "?";
    api.notify(`GitHub API calls remaining: ${remaining}`);
  },
};
```

## How it works (internals)

Plugins run in a Web Worker for crash/hang isolation — a runaway plugin can't
freeze the UI and is killed by a timeout. The worker has no direct access to
the app; every `api.*` call is forwarded to the host over a message bridge,
where it maps to Waypoint's existing Git commands. Relevant source:

| File | Role |
| --- | --- |
| `src/lib/plugins/types.ts` | Manifest / context types. |
| `src/lib/plugins/registry.ts` | Install list + persistence + manifest validation. |
| `src/lib/plugins/install.ts` | Resolve GitHub / local sources. |
| `src/lib/plugins/sandbox.worker.ts` | Worker runtime that evaluates the plugin. |
| `src/lib/plugins/host.ts` | Worker lifecycle + message bridge + timeout. |
| `src/lib/plugins/api.ts` | The `api` surface → `ipc` git commands. |
| `src/components/plugins/` | Runner provider, input dialog, Settings UI. |
