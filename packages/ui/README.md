# @butinapp/ui

The embeddable, theme-portable design system + generic data-view renderer for [Butin](https://butin.app). Pure, prop-driven React — no Electron, no data-fetching.

- `@butinapp/ui/primitives` — `button`, `card`, `input`, `badge`, `sheet`, … + `cn`
- `@butinapp/ui/dashboard` — `DashboardRenderer` · `Overview` · view-models · charts
- `@butinapp/ui/shell` — embeddable app scaffolding (`AppShell`, `Sidebar`, `ServiceTabs`, `ThemeToggle`)
- `@butinapp/ui/i18n` — en/fr label contract + formatters
- `@butinapp/ui/theme.css` — the shared brand tokens + `@theme` + dark variant

## CSS (Tailwind host)

`@butinapp/ui` ships **no compiled CSS**. Your app's single Tailwind build generates the utilities and imports the tokens:

```css
@import 'tailwindcss';
@import '@butinapp/ui/theme.css';
@source '../node_modules/@butinapp/ui/dist/**/*.js';
```

`react` / `react-dom` are peer dependencies. MIT licensed.
