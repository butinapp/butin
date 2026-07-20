# Licensing

Butin is split across two licenses. Which one applies depends on where in the tree you are.

| Path                | Package              | License    |
| ------------------- | -------------------- | ---------- |
| `packages/sdk`      | `@butinapp/sdk`      | MIT        |
| `packages/ui`       | `@butinapp/ui`       | MIT        |
| `packages/shapes`   | `@butinapp/shapes`   | MIT        |
| `packages/core`     | `@butinapp/core`     | Apache-2.0 |
| `packages/engine`   | `@butinapp/engine`   | Apache-2.0 |
| `packages/recorder` | `@butinapp/recorder` | Apache-2.0 |
| `packages/website`  | `butin-website`      | Apache-2.0 |
| `plugins/`          | `@butinapp/plugins`  | MIT        |

The root `LICENSE` is Apache-2.0 and governs everything that does not carry its own `LICENSE` file. The four MIT packages each ship one.

## Why the split

**The author surface is MIT.** `@butinapp/sdk` is what a plugin author imports and writes against, `@butinapp/ui` is a design system built to be embedded in other
people's pages, `@butinapp/shapes` is the wire format, and the plugins under `plugins/` are the worked examples an author copies to start their own. This is the
surface meant to be consumed with as little deliberation as possible, so it carries the least restrictive common license.

**The application is Apache-2.0.** The desktop app is the part someone would fork and rebrand. Apache-2.0 adds two things MIT does not: an express patent grant with
a retaliation clause (§3), and an explicit statement that the license grants no rights in the project's trademarks (§6). See [`TRADEMARK.md`](TRADEMARK.md).

## Writing a plugin

Your plugin is your own work under whatever license you choose. `@butinapp/sdk` is MIT, so importing it places no obligation on your code and no copyleft reaches
back into it.

## Contributing

By opening a pull request you agree that your contribution is licensed under the license already applying to the files you changed.
