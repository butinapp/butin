# Design guidelines

What _good_ Butin UI looks and feels like — the visual and interaction language a contributor matches when
building or reviewing UI. This is the **look and feel**; for the **wiring** (theme-portability, the token
mechanism, where components live, the no-compiled-CSS rule) see `CLAUDE.md` → "UI & embedding" and
`@butinapp/ui`.

The token values themselves live in one place — [`packages/ui/src/theme.css`](packages/ui/src/theme.css) —
and everything below references them by their semantic name.

## The feel

- **An operator surface, kept calm.** Butin shows a lot of numbers, but it should read as composed, not busy —
  generous spacing, quiet chrome, data doing the talking.
- **Honest and local.** No fake urgency, no dark patterns, no manufactured badges. The interface reflects the
  user's own data plainly; the trust story is ownership and locality, and the surface matches it.
- **You emit data, not UI.** A capability returns a `CapabilityResult`; one generic `<DashboardRenderer>` draws
  every capability. There is no per-capability React — so "designing a plugin's screen" means choosing the
  right datasets, views, and semantic roles, not styling.
- **Dark-first, theme-portable.** The palette is authored dark-first and works in light and dark. A piece
  dropped into any host inherits that host's theme — never hard-code a light or dark assumption.

## Color

- **Semantic tokens only.** Use `bg-card`, `text-muted-foreground`, `border`, `text-primary`, … — never a raw
  hex or a fixed palette. Components reference names; the host supplies values, so an embed can restyle
  everything by redefining the tokens.
- **Palette character** (defined in `theme.css`, OKLCH): a cool near-neutral canvas, a **teal/cyan primary**, a
  red `destructive`, and a five-step chart ramp. Muted grays carry most of the surface.
- **Surface elevation:** canvas → chrome → card. Cards lift off a slightly-tinted canvas; a flat all-white (or
  all-black) field reads as unfinished. Respect the three levels rather than flattening them.
- **Status vs. category — let the renderer color it.** A `status` value auto-tones by _sentiment_ (healthy /
  warning / bad); a `category` value (a role, a tier — no sentiment) gets a _stable distinct hue_. Don't
  hand-pick badge colors; pick the right role and let the renderer tone it (a column's `badges` map is the
  escape hatch only when the built-in lexicon can't infer a value).

## Type

Three faces, each with one job — don't mix them up:

- **Display — Space Grotesk** (`font-display`): the wordmark and headlines only.
- **Mono — JetBrains Mono** (`font-mono`): **all data, numbers, ids, and status.** The monospace face is the
  operator-surface signal — money, counts, timestamps, keys, statuses all render mono.
- **Sans — Inter** (`font-sans`): body copy, labels, descriptions.

The common mistake is putting a metric in the sans face or prose in mono. Numbers are mono; sentences are sans.

## Iconography — monograms, not third-party logos

Butin ships **no** vendor logos (trademark hygiene, and it keeps the repo clear of other companies' marks). A
service renders a **brand-colored letter monogram**: its name's initial on a solid tile of `meta.color`, with
an **auto-contrast** glyph (dark on light tiles, white on dark — by the color's luminance). So all a new plugin
needs for a good icon is a good `meta.color` — no asset, no import. A plugin may supply its OWN mark via
`meta.icon` (a data-URI) as an escape hatch, and a host can override per service, but the monogram is the
default everywhere (sidebar, Overview, service header).

## Data display

- **Emit semantic roles; the renderer formats.** Columns carry a role — `money` · `count` · `percent` ·
  `timestamp` · `status` · `category` · `label` · `identifier` · `url` · `text` — and the renderer formats each
  correctly (currency, locale numbers, `0.46 → 46%`, em-dash for empty). **Don't pre-format** money or numbers
  in a plugin; hand the renderer a number and a role.
- **Tables are the primary surface.** Keep them scannable: right-align numeric columns (the mono face already
  helps), and cap long free-text columns to one truncated line (with a hover peek + click-to-open full value)
  so one field can't squash its neighbours.
- **Summaries feed the rollup.** A capability's headline `summary` (with its `section`) is what surfaces on the
  cross-service Overview — choose it deliberately; it's the one number a service is known by there.

## States & motion

- **Skeletons, not "Loading…".** Show the shape of what's coming.
- **Teaching empty states.** An empty view says what to do next (connect the service, refresh), never a blank
  panel.
- **Errors offer a way forward** — a retry, a reconnect — not just a message.
- **Motion is restraint.** Transitions are quick and functional; nothing bounces for its own sake.

## Accessibility

- Contrast comes from the tokens, in both themes; the monogram glyph auto-contrasts against any brand color.
- Charts (canvas) can't ride the CSS cascade — they read token values via `getComputedStyle`, so a chart stays
  on-theme in light and dark. Anything you add that paints outside the DOM must do the same.

---

**Mechanics referenced above:** `theme.css` (the token source of truth) · `CLAUDE.md` → "UI & embedding"
(theme-portability, embedding, the no-compiled-CSS rule) · `@butinapp/ui` (the components — import `cn` and
primitives from there, not a local copy).
