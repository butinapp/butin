---
name: tidy-code
description: Use when you've just added or changed code and it should be consolidated and made to read well in its surroundings — single-use helpers to inline, hand-rolled utilities that already exist in @butinapp/sdk/util, throwaway one-use locals, abstractions with one caller, or additions that don't match the surrounding idiom. Also use when asked to clean up, tighten, simplify, or refactor recently written code in Butin.
---

# Tidy code

## Overview

New code should read **as if the file had always been this way**. The failure this fixes: lines added in
isolation — single-use helpers, throwaway locals, re-rolled utilities, one-caller abstractions — that bloat
a file and force the next reader (and you) to hunt around. Tidying **consolidates and integrates** what was
just written. It is **not** a rewrite, not a bugfix, not new surface.

**The iron rule: read the neighborhood first.** Before you tighten anything, read the whole enclosing
function/module and the nearest siblings — not just the diff. You cannot integrate code you haven't read
around, and "tightening only the changed lines" is exactly how the bloat got there.

## When to use

- Right after adding a capability, helper, command, or any chunk of code — before you call it done.
- When asked to "clean up / tighten / simplify / refactor" recently written code.
- When a file feels like it grew single-use methods or throwaways you keep tripping over.

**When NOT to use:**

- Large multi-file structural refactors — a separate, heavier effort, not a tidy pass.
- Hunting for correctness bugs → `/code-review`.
- End-of-session doc + gate hygiene → `housekeeping` (it invokes this skill for the code part).

## Scope

Changed code on this branch + the working tree (or the explicit target you were given). **Behavior stays
byte-identical** — every test that passed before passes after, unchanged. If a "tidy" would change behavior,
it is a refactor or a bugfix: **stop and flag it**, don't ship it under tidy.

## The checklist (make a todo per item)

1. **Inline single-use abstractions.** A function / const / type introduced by the change with exactly one
   caller usually belongs inlined at the call site. A one-call wrapper, a local used once on the next line,
   a type alias referenced once — fold it in. _Exception:_ keep it when its **name is the documentation**
   for something genuinely non-obvious (a good name can justify one caller).
2. **Reuse before reinventing — and never re-define a shared literal.** Before keeping a hand-rolled helper,
   check `@butinapp/sdk/util` — money (`centsToMajor` · `millicentsToMajor` · `parseDecimalAmount`), dates
   (`isoDay` · `epochMsDay`/`epochSecDay` · `dayMinus` · `utcDaysAgo` · `isoDaysAgo` · `monthKey` ·
   `currentMonthKey` · `utcMonthStart` · `MS_PER_DAY`), `startCase`, the `table`/`record` builders, the
   `*Result` presets, `STATUS_TONES`/`ROLE_TONES` — and the surrounding module. For date math those don't
   cover, reach for **luxon** (`DateTime`/`Duration` via `@butinapp/sdk/libs`), never raw ms arithmetic.
   Replace the dup; delete the local copy. The classic re-rolls: `x.slice(0, 10)` for a day (→ `isoDay`), a
   hand-written `minusDays`/`new Date(Date.parse(d) - n * 86_400_000)` (→ `dayMinus` or luxon), a private
   cents converter (→ money helpers), and a re-declared `const DAY_MS = 86_400_000` (→ import `MS_PER_DAY`). A
   load-bearing literal is defined once and imported. If a genuinely reusable primitive is missing, add it to
   `@butinapp/sdk/util` next to its siblings — don't inline a private copy.
3. **Kill throwaway intermediates.** Locals assigned once and used once, redundant temporaries, a
   `const x = …; return x`. Collapse them — unless a name materially aids readability.
4. **Match local idiom.** Make the addition indistinguishable from the code it sits in: naming, arrow-fn
   style, comment density, error handling, import order. Butin house style — arrow functions, named exports,
   `.js` specifiers, 150-col, comments only when the WHY is non-obvious.
5. **Flatten nesting / remove dead branches** the change introduced. Prefer early-return over deep nesting;
   delete now-unreachable code and any export that lost its last caller.
6. **Right altitude.** Don't abstract for one caller; don't leave three genuine copies. Three+ real
   repetitions → one helper in the right place; one use → inline. Put a shared helper where its users are,
   not stranded far from them.

## Verify (required)

Tidying must not change a single test outcome:

```bash
pnpm typecheck
pnpm --filter @butinapp/plugin-<id> test     # or `pnpm test` for the affected surface
```

If a test flips, you changed behavior — revert that edit and flag it as a separate refactor/bugfix.

## Common mistakes

| Mistake                                               | Fix                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Tightening only the diff lines                        | Read the whole enclosing scope first — that's where the bloat hides.    |
| Inlining a helper whose **name** is load-bearing docs | Keep it; one caller is fine when the name explains a non-obvious thing. |
| A "tidy" that flips a test                            | That's a behavior change. Revert, flag separately.                      |
| Adding a new helper "while I'm here"                  | Tidy **removes** surface, it doesn't add.                               |
| Leaving the old version "for reference"               | Delete it — git has the history.                                        |

## Red flags — STOP

- "I'll just add a small helper for this" — one caller? Inline it.
- "I'll keep the old one for reference" — delete it.
- A local `slice(0,10)` date format, a hand-rolled `minusDays`/`DAY_MS = 86_400_000`, or a private
  cents/percent converter — use `@butinapp/sdk/util` (or luxon via `@butinapp/sdk/libs` for date math).
- You edited the diff lines but never opened the rest of the function — go read it.
