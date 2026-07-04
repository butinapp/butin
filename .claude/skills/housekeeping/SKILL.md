---
name: housekeeping
description: Use at the end of a work session to clear accrued chores — green the gate, reconcile the docs against reality, review comments against the style rule, and tidy the changed code — and, on request, sweep the repo for a recurring code smell from the catalog. Hygiene only; the only behavior-adjacent part is a review-gated pattern sweep. Invoke when asked to "clean up", "wrap up", "do the housekeeping", "sweep for <pattern>", or "fix all the <smell>".
---

# Housekeeping

A **housekeeping pass**: the chores that accrue across a session and otherwise rot — doc drift, stale
comments, churned-up file layout, re-rolled helpers, a red gate. This is **hygiene, not feature work**: you
do not change behavior, fix bugs, add capabilities, or refactor logic. If you find a real bug, _note it in
the report_ and leave it. (The one exception is a deliberate **pattern sweep** — §6 — which is behavior-
adjacent and review-gated.)

Read first if you haven't this session: `CLAUDE.md` (conventions + the **Comment style** and **Status**
sections). Then orient:

```bash
git status && git branch --show-current && git log --oneline -8
```

**Scope.** Default to what this branch changed plus anything uncommitted — that's what needs tidying:

```bash
git diff --name-only master...HEAD ; git status --porcelain    # the changed-file set
```

If you were given a path or plugin id, scope to it. A repo-wide comment/reorg pass creates churn — use it
sparingly. **Stay in your lane:** only touch files in scope; never revert or reformat unrelated edits.

Work the steps below as a todo list. Skip a step only when its scope is genuinely empty (say so in the report).

## 1. Green the gate (do this first — it grounds the rest)

```bash
pnpm fix          # oxfmt + oxlint --fix — formatting/lint hygiene in one pass
pnpm typecheck    # tsc --noEmit across packages
pnpm test         # full vitest run — CAPTURE the real per-package counts
```

Capture the **actual** test totals (sdk · ui · core · plugins) and the **actual** plugin count
(`ls plugins | wc -l`) — step 2 reconciles the docs against these numbers, so you need the truth first. If
anything is red, that's not housekeeping — report it verbatim and stop touching docs until it's understood.

## 2. Reconcile the docs against reality

Doc drift is the recurring failure. Make the docs match what the code/tests now say — for the changed
surface, not a full rewrite.

- **`CLAUDE.md` → Status** carries the `~N tests` / `~N plugins` figures and a "Built & working" / "Next"
  list — bring them into agreement with step 1. If a change altered the **contract** (a new auth kind, a
  capability-shape change, a preset, a new SDK util), update the CLAUDE.md section that describes it —
  CLAUDE.md is the engineering reference and drift there misleads every future reader.
- **User-facing behavior changed?** Update the matching `packages/website/content/docs/*.mdx`. Internal-only
  changes don't touch the website.
- **Keep design rationale out of the code tree.** Specs, plans, and decision write-ups don't belong in code
  comments or tracked docs — keep them wherever the project keeps its planning. If you find a chunk of
  rationale inlined in a tracked file, flag it; don't relocate it yourself without asking.

## 3. Review comments against the style rule

Apply `CLAUDE.md` → **Comment style** to comments **in the changed files**. Fix or delete any comment that:

- **References history or comparison** — "now", "still", "originally", "previously", "used to", "Mirrors X",
  "like Y", "ported from". A reader has never seen an earlier version. Rewrite to describe the present state
  as if it had always been this way.
- **Carries a stale count/ordinal** — "the two transports", "the first plugin", "8 kinds" _in prose that
  will rot_. Describe each thing on its own terms.
- **Editorializes** — "clever", "simple", "fast path", "the right way", "proven".
- **Narrates the reasoning journey** instead of stating the contract. Keep only load-bearing WHY:
  invariants, ordering constraints, timing requirements, gotchas, why-not-the-obvious-thing.
- **States the obvious** — delete it.
- **Hard-wraps at 70/80 cols** — code and comments wrap at **150**.

Edit the comments; don't just list them. This step is pure judgment — be conservative: when a comment is
correct and load-bearing, leave it. Don't invent new comments.

## 4. Tidy the changed code

For the changed files, run the **`tidy-code`** skill: inline single-use helpers, reuse `@butinapp/sdk/util`
instead of re-rolling money/date/`startCase`/presets/tones, drop throwaway one-use locals, match local
idiom, keep behavior byte-identical. On top of what `tidy-code` covers, check the Butin-specific layout
(fix only when behavior-safe; otherwise flag):

- **Canonical `main.ts` layout** — imports → constants → **all types together** → domain logic in
  `capabilities[]` order → `definePlugin` → optional i18n (see `plugins/vercel/main.ts`). A `Raw*` declared
  200 lines from its only user, or a constant stranded mid-file, is the smell. Moving a declaration is safe;
  rewriting logic is not — flag those.
- **One file per plugin** — everything in `src/main.ts`, tests in `src/main.test.ts`. A separate file is the
  escape hatch only for a genuinely large single capability (a multi-parser HTML collector).
- **Divergent sources of truth** — did this change add a second place that computes, stores, or styles a
  value something else already owns? It's behavior-adjacent to fix, so **flag it** — §6 is where this smell
  is hunted repo-wide.

## 5. Hygiene scan (always, regardless of scope)

These guard the public-repo and local-first invariants — cheap, run them every pass:

- **No real secrets/PII in fixtures.** Fixtures stay synthetic/redacted — no real cookies, tokens, account
  ids, emails, or vendor slugs. Use `@example.com` / `@example.test` and fabricated numbers. Spot-check any
  fixture the changes touched.
- **No captured data in the tree.** Captured sessions/reports live under `~/butin/` only — never committed
  (and are gitignored). Confirm nothing under `.auth/`, `.sessions/`, `.data/` slipped into the diff.

## 6. Pattern sweep (on request — repo-wide, review-gated)

Distinct from §1–5: an **active, repo-wide hunt** of one cataloged smell. Reach for this only when asked to
"sweep for X" / "fix all the Y". The fix **changes behavior** (collapsing divergent sources makes drifting
surfaces agree), so it is **review-gated** — propose, then apply; never a silent sweep.

**How to sweep:**

1. Pick the pattern(s) from the catalog below (or "all"). Orient with `git status`.
2. **Hunt with the entry's _Find_ heuristic — gather ALL instances**, not the first. List them (file:line).
3. Confirm each by reading its neighborhood — a heuristic match isn't proof; drop false positives.
4. **Design the single source** the instances collapse onto: the one resolver / hook / map / type, and where
   it lives (`@butinapp/ui` stays prop-driven; the IPC-aware owner lives in `core`; pure utils in `@butinapp/sdk/util`).
5. **Propose before applying** — show the instance list + the target shape and get the go (unless told "fix
   them all").
6. Migrate every instance onto the one source; **delete the duplicates** (git has the history). Keep the gate
   green for the touched surface: `pnpm fix && pnpm typecheck && pnpm test`.

**To grow the catalog:** given a recurring smell worth tracking, append an entry in the shape below — concrete,
with a real example and a grep-able _Find_ heuristic.

### Catalog

#### Divergent sources of truth

- **Symptom** — one logical value computed/stored/styled in more than one place, free to drift: the same
  state shown with different colors/labels on different screens; a component-local `useState` holding what a
  shared cache already owns; two literal maps keyed by the same set of values.
- **Find** — the same concept derived inline at several call sites; a `useState` next to a `useQuery`/shared
  cache of the same data; duplicate `Record<...>` literals over the same keys.
- **Fix** — one source every consumer reads (a shared resolver/hook for the value; a shared map in
  `@butinapp/ui` for its presentation). Migrate every consumer; delete the local copies.
- **Safety** — behavior-adjacent: collapsing to one source makes surfaces agree, which can change what a
  screen shows or when it updates. Confirm the unified behavior is the intended one.

#### Accessor sprawl — repeated get/set pairs

- **Symptom** — a run of near-identical `getX`/`setX` over the same backing object, differing only by field,
  so every new field hand-adds another pair.
- **Find** — clusters of `export const get<Name>`/`set<Name>` that read or write a single field of one record.
- **Fix** — one generic typed accessor (`getSetting<K>(key)` / `setSetting<K>(key, value)` over a private
  `updateSettings(patch)` writer, `core/src/main/store/config-file.ts`). Keep a named accessor only where it
  carries real logic (a default, a derive, a nested merge) — not a bare passthrough.
- **Safety** — behavior-safe **only if** the generic preserves each accessor's exact read/default/merge
  semantics. Diff the behavior per key.

#### Vestigial re-export — a forwarding alias

- **Symptom** — a type/const exported under a second name whose only job is to forward to the real one
  (`export type SomeType = AbcType`, `export { x as y }`). The indirection hides where the real definition lives.
- **Find** — single-identifier type aliases (`export type \w+ = \w+$`), bare re-export lines outside a
  deliberate barrel.
- **Fix** — delete the alias; point consumers at the canonical name. **Keep** a re-export only when it's a
  deliberate public-API barrel (`@butinapp/ui` `index.ts`) or a purposeful co-location.
- **Safety** — type-only, behavior-safe; `pnpm typecheck` catches every straggler.

#### Duplicate helper made in place

- **Symptom** — the same small helper/component/markup hand-written in several files instead of imported from
  one home, each copy free to drift.
- **Find** — identical/near-identical function bodies or JSX across files; a local helper that duplicates one
  already in `@butinapp/sdk/util` (money · date · `startCase`), `@butinapp/sdk` (`table`/`record`),
  `@butinapp/sdk/presets`, or `@butinapp/ui`.
- **Fix** — reach for the existing shared helper; otherwise hoist **one** to the right home and replace every
  copy. Altitude: one use → inline; **three+ genuine copies** → one shared helper.
- **Safety** — behavior-safe when the shared version matches the copies; copies drift, so reconcile to one
  intended version and note any visible delta rather than silently picking one.

#### Duplicated type — an inline shape instead of the shared one

- **Symptom** — the same type shape written in more than one place: an inline object type that restates a
  named type, or the same `type`/`interface` declared in two modules. The copies drift.
- **Find** — repeated inline object-type literals with the same fields; two declarations with identical
  members; a structural type written inline where an exported one already covers it.
- **Fix** — define the type once in the module that owns the concept, export it, import it everywhere; replace
  each inline restatement with the import.
- **Safety** — type-only. The one risk is widening/narrowing a field while unifying — match what every site
  relies on and let `pnpm typecheck` surface gaps.

#### Duplicated magic constant — one value redefined in many files

- **Symptom** — the same load-bearing literal (a time unit like `86_400_000`, a shared timeout, a month-name
  array) defined independently in several modules under its own local name, free to drift.
- **Find** — the blind spot the function/type hunts miss: a bare _number_ or _array literal_. Two heuristics:
  (1) **grep the literal value** in every spelling (`86_400_000`/`86400000`, `30_000`/`30000`, `['Jan', 'Feb'`);
  (2) **grep `const NAME =` declared in 2+ files** (`grep -rnE 'const [A-Z][A-Z0-9_]+ ='`, tally by name) —
  same name in two files is near-certain duplication; same _value_ under different names is the drift.
- **Fix** — hoist ONE exported constant to the right home (`@butinapp/sdk` `util/*` for cross-layer values like
  `MS_PER_DAY`/`MONTH_ABBR`; a `core` module for app-only ones like `REQUEST_TIMEOUT_MS`), import it
  everywhere, delete the local copies.
- **Safety** — behavior-safe ONLY after confirming every copy is the SAME logical value. Distinct knobs that
  share a number (unrelated `30_000` timeouts) must stay separate. Same name + same meaning → collapse; same
  value + different meaning → leave. A per-service literal (`ORIGIN`, `API`, `CURRENCY`) is not this pattern.

## 7. Report, then commit

Summarize crisply: gate result (with the real counts), docs reconciled, comments fixed (count + notable
ones), tidy/reorg changes made vs flagged-only, hygiene-scan result, any **sweep** outcome, and any **bugs
you noticed but left**.

Then commit: branch off `master` if you're on it; stage the **specific files** this pass touched
(`git add <paths>`, not `-A`) and commit with a concise message; open a PR for review. State plainly what was
committed and what still needs a live account to validate.
