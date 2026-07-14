import postcss from 'postcss'

// Confine a compiled Tailwind stylesheet to the `.butin` scope so it can be dropped into any host without
// touching the host's own `:root`, universal reset, or utilities. Every rule is rewritten:
//   - a selector already carrying `.butin` (the token blocks theme.css emits: `.butin`, `.butin.dark`,
//     `.dark .butin`) is left as-is — already scoped;
//   - `:root` / `:host` / `html` / `body` (preflight roots) collapse to `.butin` (the embed wrapper IS the
//     root), so even the font/radius theme vars land on `.butin`, never the host `:root`;
//   - `*` becomes `.butin, .butin *` so the wrapper itself gets the box-sizing/border reset too;
//   - everything else (utilities, other preflight, `dark:` variants) is descendant-scoped under `.butin`.
// Keyframe steps (`from`/`to`/`50%`) are not selectors and are left untouched.

const SCOPE = '.butin'
const ROOTS = new Set([':root', ':host', 'html', 'body'])

const scopeSelector = (selector) => {
  const s = selector.trim()

  if (s.includes(SCOPE)) {
    return [s]
  }

  if (ROOTS.has(s)) {
    return [SCOPE]
  }

  if (s === '*') {
    return [SCOPE, `${SCOPE} *`]
  }

  return [`${SCOPE} ${s}`]
}

const isKeyframeStep = (rule) => rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)

const scopePlugin = () => ({
  postcssPlugin: 'scope-butin',
  Rule(rule) {
    if (isKeyframeStep(rule)) {
      return
    }

    rule.selectors = [...new Set(rule.selectors.flatMap(scopeSelector))]
  }
})

scopePlugin.postcss = true

export const scopeCss = (css) => postcss([scopePlugin()]).process(css, { from: undefined }).css
