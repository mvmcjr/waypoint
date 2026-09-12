---
name: Waypoint
description: A local Git GUI, no account required.
colors:
  position-teal: "oklch(0.79 0.145 185)"
  position-teal-text: "oklch(85.5% 0.138 181.071)"
  chart-night: "oklch(0.118 0.008 250)"
  chart-night-deep: "oklch(0.108 0.01 250)"
  surface-raised: "oklch(0.158 0.01 248)"
  surface-float: "oklch(0.162 0.012 248)"
  surface-muted: "oklch(0.195 0.012 248)"
  sidebar-hover: "oklch(0.182 0.012 248)"
  ink: "oklch(0.88 0.008 240)"
  ink-bright: "oklch(0.82 0.008 240)"
  ink-muted: "oklch(0.50 0.016 245)"
  hairline: "oklch(1 0 0 / 7%)"
  hairline-sidebar: "oklch(1 0 0 / 6%)"
  hairline-input: "oklch(1 0 0 / 11%)"
  hazard-red: "oklch(0.65 0.22 20)"
  marker-amber: "oklch(87.9% 0.169 91.605)"
  dual-track-indigo: "oklch(78.5% 0.115 274.713)"
  single-track-slate: "oklch(86.9% 0.022 252.894)"
  remote-slate: "oklch(70.4% 0.04 256.788)"
  wip-orange: "oklch(83.7% 0.128 66.29)"
  diff-add: "oklch(87.1% 0.15 154.449)"
  diff-del: "oklch(80.8% 0.114 19.571)"
  conflict-ours: "oklch(80.9% 0.105 251.813)"
  conflict-theirs: "oklch(82.7% 0.119 306.383)"
  lane-teal: "#2dd4bf"
  lane-indigo: "#818cf8"
  lane-rose: "#fb7185"
  lane-amber: "#fbbf24"
  lane-violet: "#a78bfa"
  lane-sky: "#38bdf8"
  lane-emerald: "#34d399"
  lane-orange: "#fb923c"
typography:
  display:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "36px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1
  body:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.43
  row:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  meta:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.3
    fontFeature: "'tnum' 1"
  label:
    fontFamily: "'Geist Variable', sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.12em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.3
rounded:
  badge: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  full: "9999px"
spacing:
  unit: "4px"
  control-height: "32px"
  row-height: "34px"
  lane-width: "18px"
  refs-column: "160px"
  sidebar-width: "224px"
  tabbar-height: "36px"
components:
  button-primary:
    backgroundColor: "{colors.ink-bright}"
    textColor: "{colors.chart-night}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "oklch(1 0 0 / 3.3%)"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline-hover:
    backgroundColor: "oklch(1 0 0 / 5.5%)"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "oklch(0.195 0.012 248 / 50%)"
  button-destructive:
    backgroundColor: "oklch(0.65 0.22 20 / 20%)"
    textColor: "{colors.hazard-red}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-destructive-hover:
    backgroundColor: "oklch(0.65 0.22 20 / 30%)"
  input:
    backgroundColor: "oklch(1 0 0 / 3.3%)"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "4px 10px"
    height: "32px"
  ref-badge-head:
    backgroundColor: "oklch(0.704 0.14 182.503 / 20%)"
    textColor: "{colors.position-teal-text}"
    typography: "{typography.mono}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  ref-badge-tag:
    backgroundColor: "oklch(0.769 0.188 70.08 / 12%)"
    textColor: "{colors.marker-amber}"
    typography: "{typography.mono}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  ref-badge-dual-track:
    backgroundColor: "oklch(0.585 0.233 277.117 / 15%)"
    textColor: "{colors.dual-track-indigo}"
    typography: "{typography.mono}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  ref-badge-local:
    backgroundColor: "oklch(0.554 0.046 257.417 / 12%)"
    textColor: "{colors.single-track-slate}"
    typography: "{typography.mono}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  ref-badge-remote:
    backgroundColor: "oklch(0.446 0.043 257.281 / 10%)"
    textColor: "{colors.remote-slate}"
    typography: "{typography.mono}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  timeline-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.row}"
    height: "34px"
  timeline-row-hover:
    backgroundColor: "oklch(1 0 0 / 4%)"
  timeline-row-selected:
    backgroundColor: "oklch(1 0 0 / 7%)"
  timeline-row-head-selected:
    backgroundColor: "oklch(0.704 0.14 182.503 / 10%)"
  sidebar-section-label:
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    padding: "6px 10px"
  sidebar-ref-row:
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "3px 12px"
  tab-active:
    backgroundColor: "{colors.chart-night}"
    textColor: "{colors.ink}"
    padding: "0 8px 0 12px"
    height: "36px"
  risk-banner-caution:
    backgroundColor: "oklch(0.769 0.188 70.08 / 10%)"
    textColor: "{colors.marker-amber}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  risk-banner-danger:
    backgroundColor: "oklch(0.65 0.22 20 / 10%)"
    textColor: "{colors.hazard-red}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  dialog:
    backgroundColor: "{colors.surface-float}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "16px"
  context-menu:
    backgroundColor: "{colors.surface-float}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "4px"
  context-menu-item-focus:
    backgroundColor: "{colors.surface-muted}"
    rounded: "{rounded.md}"
    padding: "4px 6px"
---

# Design System: Waypoint

## Overview

**Creative North Star: "The Night Chart"**

Waypoint is a navigator's chart read in the dark. The commit graph is the chart itself: lanes are routes, commits are waypoints, merges are where routes meet. Everything on the canvas is drawn in low light, dim cool ink on near-black, so the one lit marker, Position Teal, reads instantly as *you are here*: HEAD, the current branch, the focused control. The jewel-tone lanes are the only broad color on screen, and they are data, not decoration.

The chart is dense because the navigator is a professional who reads it all day. Rows are 34px, metadata runs at 10–11px, and labels shrink to small caps. Hierarchy comes from contrast, meaning ink opacity, tonal steps, and the single accent, never from size drama. Chrome recedes; state speaks. Controls are small but **crisp and tactile**: a button reads unmistakably as pressable, presses answer with a physical 1px give, and borders stay firm enough to find without hunting.

Two looks are explicitly rejected. Waypoint never becomes gradient-and-neon "gamer Git": no saturated gradients, glowing chrome, or illustration-heavy panels. It also never settles for the stock shadcn gray-on-gray starter look: components are generated through shadcn, but every one is tuned to the Night Chart palette and conventions before it ships.

**Key Characteristics:**
- Dark-only, cool-tinted near-black canvas with tonal layering for depth
- One accent (Position Teal) that means current position and nothing else
- Eight jewel-tone graph lanes as the only broad color field
- A dense, contrast-driven type scale in Geist, with monospace for every Git identity (hash, ref, branch)
- White-alpha overlays for every hover and selection, so state reads the same over any lane color
- Motion that only softens state changes, 75–150ms, never choreography

## Colors

A dim, cool, near-monochrome chart with one lit marker and a strictly semantic set of state colors.

### Primary
- **Position Teal** (oklch(0.79 0.145 185)): the *you-are-here* color. HEAD badge, HEAD row edge, the sidebar HEAD dot, the focus ring on every control, and the selected-row edge. The lighter **Position Teal Text** (oklch(85.5% 0.138 181.071)) carries teal text on tinted fills (HEAD badge, HEAD sidebar row). In markup it is mostly applied as Tailwind teal utilities at low alpha (`teal-500/10` fills, `teal-400` edges). `--ring` and `--sidebar-primary` are the token form.

### Secondary
- **Marker Amber** (oklch(87.9% 0.169 91.605)): the "pinned but not moving" color. Tag badges, stash badges, the "local" unpushed-tag marker, the WIP change counter, and the caution risk banner for reflog-recoverable rewrites (rebase, squash).
- **Dual-Track Indigo** (oklch(78.5% 0.115 274.713)): a branch that exists both locally and on a remote.

### Tertiary
- **WIP Orange** (oklch(83.7% 0.128 66.29)): the working tree's live, uncommitted state on the WIP row, and conflict markers.
- **Diff Add / Diff Del** (oklch(87.1% 0.15 154.449) / oklch(80.8% 0.114 19.571)): diff line text over 10% green / red fills; the `A` / `D` status letters in staging use the more saturated 400 steps.
- **Conflict Ours / Theirs** (oklch(80.9% 0.105 251.813) / oklch(82.7% 0.119 306.383)): blue marks "ours" and purple marks "theirs" in the hunk picker; teal marks the resolved "both" choice.
- **Hazard Red** (oklch(0.65 0.22 20)): destructive menu items, danger banners, and the destructive button. It is reserved for true data loss (see Components).
- **Graph lanes** (`#2dd4bf` teal, `#818cf8` indigo, `#fb7185` rose, `#fbbf24` amber, `#a78bfa` violet, `#38bdf8` sky, `#34d399` emerald, `#fb923c` orange): cycled by lane color index (`idx % 8`). Edges are drawn at 1.5px stroke with 0.75 opacity.

### Neutral
- **Chart Night** (oklch(0.118 0.008 250)): the canvas: app background, timeline, active tab.
- **Chart Night Deep** (oklch(0.108 0.01 250)): the sidebar, one step darker so the canvas reads as the lit table.
- **Surface Raised / Surface Float** (oklch(0.158 0.01 248) / oklch(0.162 0.012 248)): cards, and floating layers (dialogs, menus, palette, popovers).
- **Surface Muted** (oklch(0.195 0.012 248)): subtle fills, focused menu items, and the dialog footer band at 50%. **Sidebar Hover** (oklch(0.182 0.012 248)) is its sidebar sibling.
- **Ink** (oklch(0.88 0.008 240)): primary text. Rows dim it further: HEAD commit message at 95%, other commit messages at 75%, non-HEAD sidebar refs at 55%.
- **Ink Bright** (oklch(0.82 0.008 240)): the primary button fill and the active-tab top rule.
- **Ink Muted** (oklch(0.50 0.016 245)): secondary text, usually further dimmed (author at 50%, short hash at 30%, section labels at 55%).
- **Hairline / Hairline Input** (oklch(1 0 0 / 7%) / 11%): all borders are white alpha, not flat gray, so they sit correctly on every tonal step. The sidebar border is 6%.
- **Single-Track Slate / Remote Slate** (oklch(86.9% 0.022 252.894) / oklch(70.4% 0.04 256.788)): local-only and remote-only branch badges. Remote-only is the dimmest badge.

### Named Rules

**The One Position Rule.** Teal means *current position*: HEAD, the checked-out branch, the selected row edge, focus. It never decorates, never marks a generic hover, and never tints menu chrome. If a new element is not "where you are," it is not teal.

**The Marker Amber Rule.** Amber marks refs and states that are pinned or not yet shared: tags, stashes, detached HEAD, unpushed-local, work in progress, and caution. Do not use it for warnings that are really red, or for decoration.

**The Alpha Overlay Rule.** Hover and selection are white-alpha overlays (4% hover, 7% selected) on top of whatever is beneath, never new solid fills. State must read identically over every lane color.

## Typography

**Display Font:** Geist Variable (with sans-serif)
**Body Font:** Geist Variable (with sans-serif)
**Label/Mono Font:** system monospace stack (ui-monospace, SFMono-Regular, Menlo, Consolas, …)

**Character:** a single, neutral grotesque tuned for density, paired with monospace for anything that *is* Git: hashes, ref names, branch names in menus. Geist carries prose and chrome; mono carries identity.

### Hierarchy
- **Display** (700, 36px, tracking -0.025em): the Waypoint wordmark on the welcome screen only.
- **Title** (500, 16px, line-height 1): dialog titles.
- **Body** (400, 14px): buttons, inputs, menu items, dialog copy.
- **Row** (400, 13px): commit messages in timeline rows; sidebar ref rows run at 12px.
- **Meta** (400, 11px, tabular numerals): author, relative time, counts. Always dimmed with Ink Muted.
- **Label** (600, 10px, tracking 0.12em, uppercase): sidebar section headers and small group headers. Counts beside them drop to 9px at 40% opacity.
- **Mono** (400, 10px): ref badges, short hashes (7 chars), the version stamp. Badge glyph icons go down to 8px.

### Named Rules

**The Mono-for-Identity Rule.** Every Git identifier (OID, short hash, branch, tag, ref) renders in monospace. Badge truncation depends on it: the middle-truncation budget is computed from a fixed px-per-character ratio.

**The Contrast-Not-Size Rule.** Hierarchy inside dense views comes from ink opacity and weight, not from bigger type. Stay within the 8–14px band in operating views; 16px is for dialog titles, 36px for the wordmark.

## Layout

A fixed desktop shell: a tab bar (36px) across the top, a 224px sidebar (Chart Night Deep) on the left, and the timeline canvas filling the rest, with detail and staging panels opening beside it. The timeline is a strict row grid: 34px rows, 18px per graph lane, and a resizable refs column (default 160px) on the left whose width drives badge truncation. The right-hand metadata cluster (author, hash, date) sheds columns as the window narrows: author hides below `md`, hash below `lg`, and the date column holds a fixed 90px, right-aligned with tabular numerals.

Spacing follows Tailwind's 4px unit, used tightly: 2–10px gaps inside rows, 12px row gutters, 16px dialog padding. Density is the point. The timeline is virtualized (overscan 20 rows), and long graph edges are indexed separately so scroll cost stays flat on large repositories.

## Elevation & Depth

Depth is tonal first. The sidebar sits one lightness step below the canvas, cards and floating layers one to two steps above it, and every edge is a white-alpha hairline. Surfaces are flat at rest. Shadows appear only on layers that genuinely float above the canvas: context, dropdown, and select menus, hover cards, and the command palette. Dialogs rely on a 10% foreground ring over a lightly blurred 10% black backdrop.

### Shadow Vocabulary
- **Menu float** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`, plus a 1px foreground/10% ring): context, dropdown, and select menus and hover cards; dropdown submenus step up to Tailwind's `shadow-lg`.
- **Palette float** (`box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25)`): the command palette, over a 50% black backdrop.
- **HEAD glow** (`box-shadow: 0 0 4px rgba(45,212,191,0.5)`): the sidebar HEAD dot. In the graph, the HEAD commit dot carries two concentric teal rings at 0.12 and 0.3 opacity.

### Named Rules

**The Float-Only Shadow Rule.** A shadow means "this is above the canvas and will go away." Nothing docked, inline, or at rest gets one.

**The Single Glow Rule.** Glow exists only on HEAD: the graph ring and the sidebar dot. No glowing buttons, borders, or panels anywhere else.

## Shapes

Gently rounded and small. The base radius is 10px (`--radius`), and the scale derives from it: 6px for sidebar rows, 8px for menu items and small buttons, 10px for buttons, inputs, menus, and risk banners, and 14px for dialogs and the command palette. Ref badges and inline chips drop to 4px so they read as tags, not buttons. Circles are reserved for graph dots, the HEAD indicator dot, and the conflict-choice pills. Graph edges bend with a 5px corner radius, and commit dots are 4.5px in radius.

## Components

### Buttons
Crisp and tactile: small, clearly pressable, and firm.
- **Shape:** gently rounded (10px); sizes are 24/28/32/36px tall (`xs`/`sm`/default/`lg`), plus square icon variants.
- **Primary:** Ink Bright fill with Chart Night text. A moonlit, near-white button, deliberately *not* teal, so the accent stays reserved for position.
- **Outline / Ghost / Secondary:** white-alpha fills that brighten on hover. Outline carries the input hairline border.
- **Destructive:** a Hazard Red tint (20% fill, red text), used only for true no-undo data loss.
- **Hover / Focus / Press:** a 3px focus ring in Position Teal at 50%, and a 1px downward press (`translate-y-px`). Disabled controls drop to 50% opacity.

### Ref badges (signature)
- **Style:** 10px mono on 4px-radius chips, with a tinted fill, matching text, and a slightly stronger border in the same hue.
- **Variants:** HEAD (teal, `✓` prefix, medium weight), tag (amber, tag glyph), local+remote (indigo), local-only (slate), remote-only (dim slate). Presence glyphs are appended, not swapped: a monitor glyph means a local copy exists, a globe glyph means a remote copy exists, both at 8px and 40–50% opacity.
- **Behavior:** middle-truncated to the width the resizable refs column allows, with the full name in the native tooltip. More than three refs collapse into a "+N" hover card.

### Timeline rows (signature)
- **Structure:** refs column, then graph spacer, commit message, and a right-aligned metadata cluster, all at a fixed 34px height with a 2px left edge.
- **States:** hover adds a 4% white overlay. Selected gets a 7% overlay and a 50% teal edge. HEAD gets a 4% teal wash and a 70% teal edge. Selected HEAD gets a 10% teal wash and a full teal edge. A right-clicked row keeps the selection highlight while its menu is open.
- **Stash rows:** 35% opacity, italic, with dashed graph edges.
- **WIP row:** pinned above the scroll area, with an orange working-tree label, a `// WIP` mono tag, and an amber change counter.

### Inputs / Fields
- **Style:** 32px tall, 10px radius, Hairline Input border over a 3.3% white fill.
- **Focus:** the border shifts to teal with a 3px teal ring at 50%.
- **Error / Disabled:** Hazard Red border with a 40% red ring; disabled fields dim to 50%. The sidebar filter is a quieter inline variant: 11px text on a 4% white field with a 6% border.

### Navigation
- **Tabs:** 36px strip on a faint 10% muted wash. The active tab takes the Chart Night canvas color with an Ink Bright 2px top rule; inactive tabs are Ink Muted and brighten on hover. The close control is always visible on the active tab and appears on hover elsewhere.
- **Sidebar sections:** 10px icon at 70% opacity, then the uppercase label, then a 9px count and a chevron that rotates 90° over 150ms. Ref rows use 12px text; HEAD shows teal text and the glowing teal dot.
- **Command palette:** a 560px floating panel placed 18% from the top, with a 14px radius, borderless search input, and hairline-separated footer.

### Menus & dialogs
- **Context menus:** Surface Float, 10px radius, 4px padding, and 16px leading Lucide icons at full opacity. Focus uses a neutral Surface Muted fill, never teal. Destructive items are Hazard Red and always separated from the rest.
- **Dialogs:** Surface Float, 14px radius, and 16px padding. The footer is a full-bleed band with a Surface Muted 50% fill and a top hairline. Motion is fade plus zoom-from-95% over 100ms.
- **Risk banners:** a 10px-radius tinted strip with a triangle alert icon, in two tiers. *Caution* (amber) is for history rewrites the reflog can recover (rebase, squash); its confirm button stays the normal primary. *Danger* (red) is for no-undo data loss (hard reset, force push), and only danger pairs with the destructive button.

## Do's and Don'ts

### Do:
- **Do** reserve Position Teal for HEAD, current state, and focus.
- **Do** build hover and selection from white-alpha overlays (4% hover, 7% selected) so they read over every lane color.
- **Do** render every hash, ref, and branch name in monospace.
- **Do** keep operating-view type between 8px and 14px, and create hierarchy with ink opacity and weight.
- **Do** make controls crisp and tactile: firm hairline borders, a visible 3px teal focus ring, and a 1px press.
- **Do** classify risk by what is actually lost: amber caution for reflog-recoverable rewrites, red danger (and the destructive button) only for no-undo loss.
- **Do** keep motion at 75–150ms and use it only to soften state changes (row color, chevron, menu and dialog entry).
- **Do** generate base components with the shadcn CLI, then tune them to the Night Chart palette before shipping.

### Don't:
- **Don't** drift toward gradient-and-neon "gamer Git": no saturated gradients, glowing chrome, or illustration-heavy panels.
- **Don't** ship stock shadcn gray-on-gray; an untuned default component is unfinished.
- **Don't** add a second accent or tint generic hover, menu focus, or chrome with teal.
- **Don't** add glow anywhere except HEAD.
- **Don't** put shadows on docked or at-rest surfaces; shadows are for floating layers only.
- **Don't** use the red destructive button for recoverable operations like rebase or squash.
- **Don't** add page-load choreography or scroll-triggered animation.
