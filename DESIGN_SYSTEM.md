# Waypoint Design System

Waypoint ships **dark-only** ("Obsidian" theme). No light/dark toggle exists in the app — `:root` defines a light palette (shadcn boilerplate) but nothing applies it; `.dark` is the only palette actually used at runtime. Treat `.dark` values in `src/index.css` as the real tokens.

## 1. Color

### Core semantic tokens (`src/index.css`, `.dark`)

| Token | Value | Use |
|---|---|---|
| `--background` | `oklch(0.118 0.008 250)` | App background — dark, cool-tinted |
| `--foreground` | `oklch(0.88 0.008 240)` | Primary text |
| `--card` / `--popover` | `oklch(0.158 0.01 248)` / `oklch(0.162 0.012 248)` | Elevated surfaces |
| `--sidebar` | `oklch(0.108 0.01 250)` | Sidebar bg — slightly darker than app bg |
| `--sidebar-accent` | `oklch(0.182 0.012 248)` | Sidebar hover/active row |
| `--muted` / `--accent` | `oklch(0.195 0.012 248)` | Subtle fills |
| `--muted-foreground` | `oklch(0.50 0.016 245)` | Secondary text |
| `--border` | `oklch(1 0 0 / 7%)` | Hairline borders (white alpha, not a flat gray) |
| `--input` | `oklch(1 0 0 / 11%)` | Input borders |
| `--ring` / `--sidebar-primary` | `oklch(0.79 0.145 185)` (teal) | Focus ring, sidebar HEAD accent |
| `--destructive` | `oklch(0.65 0.22 20)` | Delete/danger |

**Accent color is teal**, not the shadcn default. It replaced an original green/blue direction. Used via Tailwind utilities directly (`text-teal-400`, `bg-teal-500/10`, etc.) rather than through a `--primary` token — most teal usage in components is hardcoded Tailwind teal, not a CSS variable.

### Graph lane colors (`src/components/timeline/GraphLayer.tsx`)

8 jewel tones, cycled by `laneColor(idx % 8)`:

```
teal    #2dd4bf
indigo  #818cf8
rose    #fb7185
amber   #fbbf24
violet  #a78bfa
sky     #38bdf8
emerald #34d399
orange  #fb923c
```

HEAD commit dot always rendered in teal (`#2dd4bf`) regardless of lane color, with two concentric glow rings (`opacity 0.12` / `0.3`) — the only "glow" effect in the app, reserved for HEAD.

### Ref badge colors (`src/components/timeline/RefBadge.tsx`)

| Badge | Style |
|---|---|
| HEAD branch | `bg-teal-500/20 text-teal-300 border-teal-500/40`, `✓` prefix |
| Tag | `bg-amber-500/12 text-amber-300/85 border-amber-500/20`, `Tag` icon |
| Local + remote branch | `bg-indigo-500/15 text-indigo-300/90 border-indigo-500/25` |
| Local-only branch | `bg-slate-500/12 text-slate-300/80 border-slate-500/20` |
| Remote-only branch | `bg-slate-600/10 text-slate-400/70 border-slate-500/15` |
| Unpushed local tag marker (sidebar) | `text-amber-500/80 bg-amber-500/10 border-amber-500/20`, uppercase "local" |

Convention: **amber = tag / detached / unpushed-local state**, **teal = HEAD / current**, **indigo = dual-tracked branch**, **slate = single-tracked branch**. `Monitor` icon = has local, `Globe` icon = has remote — appended to badges, not swapped.

### Row state colors (timeline, sidebar)

- Selected + HEAD: `border-l-teal-400 bg-teal-500/10`
- HEAD (not selected): `border-l-teal-500/70 bg-teal-500/[0.04]`
- Selected (not HEAD): `border-l-teal-400/50 bg-white/[0.07]`
- Default hover: `hover:bg-white/[0.04]`
- Stash rows: `opacity-35 italic`, dashed edges in the graph

Pattern: state colors are built from **white-alpha overlays** (`bg-white/[0.04]`, `bg-white/[0.07]`) on top of the dark background rather than distinct solid colors — keeps hover/selection subtle and consistent across any lane color underneath.

## 2. Typography

- **Sans / heading font**: Geist Variable (`@fontsource-variable/geist`), applied globally via `--font-sans` and `--font-heading`
- **Mono**: Tailwind's default mono stack, used for OIDs, hashes, ref names, branch names in menus (`font-mono`)
- Body text in dense UI (timeline rows, sidebar) runs small: `text-[13px]` (commit message), `text-[12px]` (sidebar ref rows), `text-[11px]`/`text-[10px]` (metadata: author, relative time, hash), `text-[9px]`/`text-[8px]` (badge icons/counts)
- Section headers (sidebar group labels): `text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55`
- No distinct display/heading face — this is a dense developer tool, not a marketing surface, so type scale is optimized for information density over hierarchy drama

## 3. Layout constants

Defined in `src/components/timeline/GraphLayer.tsx`:

| Constant | Value |
|---|---|
| `ROW_HEIGHT` | 34px |
| `LANE_WIDTH` | 18px |
| `REFS_COL_WIDTH` | 160px |
| Commit dot radius | 4.5px (`DOT_R`) |
| Edge corner radius | 5px (`CURVE_R`) |
| Edge stroke width | 1.5px, `opacity: 0.75` |

Timeline is virtualized (overscan 20 rows); only visible rows render. Long graph edges (span > 256 rows) are indexed separately from short edges to keep scroll cost bounded regardless of repo size.

## 4. Radius scale

`--radius: 0.625rem` (10px) is the base; everything else derives from it in `@theme inline`:

```
--radius-sm:  calc(var(--radius) * 0.6)   → 6px
--radius-md:  calc(var(--radius) * 0.8)   → 8px
--radius-lg:  var(--radius)               → 10px
--radius-xl:  calc(var(--radius) * 1.4)   → 14px
--radius-2xl: calc(var(--radius) * 1.8)   → 18px
--radius-3xl: calc(var(--radius) * 2.2)   → 22px
--radius-4xl: calc(var(--radius) * 2.6)   → 26px
```

Dialogs use `rounded-xl`. Badges/rows use small radii (`rounded`, `rounded-sm`).

## 5. Components

Base components in `src/components/ui/` are **shadcn-generated** (Base UI primitives + `class-variance-authority`), never hand-written — see `feedback_shadcn_components` memory. Generate new ones with `pnpm dlx shadcn@latest add <component>`.

### Button (`button.tsx`)

Variants: `default`, `outline`, `secondary`, `ghost`, `destructive`, `link`.
Sizes: `default` (h-8), `xs` (h-6), `sm` (h-7), `lg` (h-9), plus square `icon`/`icon-xs`/`icon-sm`/`icon-lg`.
Shared behavior: `active:translate-y-px` press feedback, `focus-visible:ring-3 ring-ring/50`, icons auto-sized via `[&_svg:not([class*='size-'])]:size-*` unless overridden.

### Dialog (`dialog.tsx`)

Popup: `rounded-xl bg-popover ring-1 ring-foreground/10`, centered, `zoom-in-95`/`fade-in-0` on open (100ms), reverse on close. Footer is visually separated: `-mx-4 -mb-4 border-t bg-muted/50 rounded-b-xl`. Close button is always top-right `ghost` `icon-sm`.

### Context menus (`context-menu.tsx`), used heavily for commit/branch/tag actions

Destructive items get `text-destructive focus:text-destructive`, always separated from non-destructive items by `ContextMenuSeparator`.

### Command Palette (`CommandPalette.tsx`)

Explicitly forces `className="dark"` on its own popup — the one place dark mode is applied via class rather than relying on the global `.dark` root, presumably to guarantee correct rendering regardless of future light-mode work.

### Risk banners (`Dialogs.tsx`, local `RiskBanner` helper)

Action dialogs that carry real risk use a shared `RiskBanner` component rather than ad hoc `⚠`-prefixed paragraphs, scaled by what's actually at stake — **not** by how scary the action sounds:

- `level="danger"` (red, `border-destructive/30 bg-destructive/10 text-destructive`) — operations that lose data with no in-app undo: hard reset, force push. Primary button uses `variant="destructive"` here too.
- `level="caution"` (amber, `border-amber-500/30 bg-amber-500/10 text-amber-300`) — operations that rewrite history but stay recoverable via reflog: rebase, squash. Primary button stays `variant="default"` — **do not** use the red button variant for these; it was previously misapplied and made a routine action (rebase) look as dangerous as an unrecoverable one.

When adding a new destructive-ish dialog, classify it against these two tiers before picking a button variant or banner level.

## 6. Iconography

Lucide React exclusively. Sizes are deliberately tiny and context-dependent, not a fixed 16/20/24 scale: `size={8}`–`size={10}` for inline badge/label icons, default (~16px via `size-4` button rule) for interactive controls. Icons are almost always paired with reduced opacity (`opacity-40`–`opacity-70`) rather than a dimmed color token, so they recede against text at any lane/badge color.

**Context/dropdown menu items**: leading icon at the default auto-sized 16px (no explicit `size-*` class needed — `ContextMenuItem`/`DropdownMenuItem` already auto-size any child `<svg>` via `[&_svg:not([class*='size-'])]:size-4`), no opacity dimming. Commit context menu icon choices, for reuse: `Copy` (copy hash), `GitBranch` (checkout), `GitBranchPlus` (new branch), `Tag` (new tag), `GitMerge` (merge), `GitCommitVertical` (cherry-pick — lucide has no dedicated cherry icon), `Undo2` (revert), `GitFork` (rebase), `Combine` (squash), `RotateCcw` (reset HEAD). Destructive items (e.g. reset) get the icon for free via `currentColor` once the item has `text-destructive` — no separate icon color needed.

## 7. Motion

Motion is minimal and functional, not decorative:
- Dialogs/menus: `fade-in-0 zoom-in-95` in ~100–150ms via `tw-animate-css` (`data-open:animate-in` / `data-closed:animate-out`)
- Row hover/selection: `transition-colors duration-75` — fast, not springy
- Sidebar chevron rotate: `transition-transform duration-150`
- No page-load choreography, no scroll-triggered reveals — this is a tool used all day, not a landing page; motion exists only to soften state changes

## 8. Scrollbars

Custom thin scrollbars everywhere (`src/index.css` `@layer base`): 14px webkit scrollbar, `border-radius: 7px`, thumb color `--muted` → `--muted-foreground` on hover, 3px background-colored border to inset the thumb from the track edge. Firefox gets `scrollbar-width: thin` with matching colors.

## 9. Patterns worth reusing

- **Sidebar section header**: icon (10px, `opacity-70`) + uppercase 10px label (`tracking-[0.12em]`) + count + `ChevronRight` that rotates 90° when open. See `RefGroup` in `RefTree.tsx`.
- **HEAD indicator dot**: `w-1.5 h-1.5 rounded-full bg-teal-400` with a soft `shadow-[0_0_4px_rgba(45,212,191,0.5)]` — the only glow used outside the timeline HEAD ring.
- **Truncated badges with tooltip**: badge text is middle-truncated (`truncateMiddle`) with full name in native `title` attribute — used for long branch/tag names.
- **"+N more" overflow**: hidden refs beyond `MAX_REFS = 3` collapse into a `HoverCard` trigger rather than wrapping or scrolling.
- **Context-menu target highlight**: right-clicking a timeline row doesn't change selection, so `Timeline.tsx` tracks `contextTargetOid` (set via each `CommitContextMenu`/`StashContextMenu`'s `onOpenChange`) and `CommitRow` treats `isContextTarget` the same as `isSelected` for its highlight class — reuses the existing selection visual language rather than inventing a new one, so a right-clicked row stays visibly marked for as long as its menu is open.

## Notes for extending

- Don't introduce a new accent color — teal is load-bearing for "this is HEAD / current / active" across timeline, sidebar, and badges. Amber is reserved for tags/detached/unpushed state. Keep that split.
- Prefer white-alpha overlays (`bg-white/[0.0X]`) for hover/active states over new solid background colors, to stay consistent across arbitrary lane colors.
- New base UI components: use `pnpm dlx shadcn@latest add <component>`, don't hand-roll.
- Keep motion under ~150ms and purposeful; this app is optimized for information density and fast repeated use, not first-impression spectacle.
