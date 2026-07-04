# Roadmap

Butin is an active project. This file tracks direction; day-to-day work lives in the issue tracker.

## Standing design constraints

These are deliberate and not up for revision:

- **Pull-only.** Every fetch is user-initiated (per-tab Refresh + a page-level Refresh-All). No background process, no auto-refresh on launch, no scheduled/cron
  refresh. Butin is a dashboard you open and refresh by hand.
- **Local-first.** Captured data never leaves the machine, and the account a plugin reads is always your own.

## Near-term

- Grow the plugin roster — each new service is one folder under `plugins/`.
- Broaden live-account coverage of existing capabilities.
- Harden the browser-engine replay paths for services whose edge requires a real browser identity.
- Sharpen plugin-author onboarding (docs + the scaffolding flow).

Specifics and status live in the issue tracker.

## Contributing

New plugins are the main way to extend Butin — one folder under `plugins/` per service. See [CONTRIBUTING.md](CONTRIBUTING.md) and the `update-plugin` skill under
`.claude/skills/` for the full walkthrough.
