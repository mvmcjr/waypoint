# example-plugin

A reference Waypoint plugin. Copy this folder as a starting point for your own.

## Try it

1. Open Waypoint → **Settings → Plugins → Folder…** and pick this directory.
2. The three commands appear at their surfaces:
   - **Branch from here…** — right-click any commit.
   - **Show branch as slug** — right-click a branch (sidebar or timeline badge).
   - **GitHub: rate limit** — command palette (Ctrl/Cmd-Shift-P) and the toolbar.

## What it demonstrates

| Command | Surface(s) | API used |
| --- | --- | --- |
| `branch-from-commit` | commit menu | declared `inputs`, `ctx.commitOid`, `api.createBranch` |
| `show-branch-slug` | branch menu | `ctx.branchName`, `api.notify` |
| `github-rate-limit` | palette, toolbar | `api.prompt`, `api.fetch` |

See [`../docs/plugins.md`](../docs/plugins.md) for the full manifest schema and
`api` reference.

## License

MIT, like the rest of Waypoint. Copy it, rename it, relicense your plugin however
you like; no attribution needed.
