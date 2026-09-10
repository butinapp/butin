# Security Policy

Butin runs inside your own authenticated sessions and stores credentials encrypted on your machine.
Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's **[private vulnerability reporting](https://github.com/butinapp/butin/security/advisories/new)**
(the repository's **Security** tab → **Report a vulnerability**). This keeps the report confidential
until a fix is available.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The affected version / commit and your environment (OS, Electron version).

You can expect an initial acknowledgement within a few days. Once the issue is confirmed, a fix and a
coordinated disclosure timeline will be worked out with you.

## Scope

Butin is **local-first**: it has no backend and takes no custody of your credentials. The security
surface that matters most:

- **Credential storage** — cookies/tokens are encrypted at rest via the OS keychain (`safeStorage`)
  under `~/butin/`. Off-Electron (tests), `safeStorage` is unavailable and values fall back to
  plaintext; that path is for tests only.
- **The plugin trust boundary** — plugins execute inside your authenticated sessions. Only bundled,
  reviewed first-party plugins ship today; there is no runtime loading of untrusted plugins. Reports
  about ways a plugin could exfiltrate session data or escape its intended scope are in scope.
- **Session replay / transport** — anything that could leak credentials to an unintended host.

Reports of leaked secrets or real account data committed to the repository are also welcome.
