import { describe, expect, it } from 'vitest'

import { scopeCss } from './scope-css.mjs'

describe('scopeCss', () => {
  it('collapses preflight roots (:root / :host / html / body) to .butin', () => {
    const out = scopeCss(':root, :host { --card: white } html { line-height: 1.5 } body { margin: 0 }')

    expect(out).toContain('.butin {')
    // No bare root/element selector survives — nothing lands on the host document.
    expect(out).not.toMatch(/(^|})\s*:root/)
    expect(out).not.toMatch(/(^|})\s*html\s*{/)
    expect(out).not.toMatch(/(^|})\s*body\s*{/)
  })

  it('scopes the universal reset to the wrapper AND its descendants', () => {
    const out = scopeCss('*, ::before, ::after { box-sizing: border-box }')

    expect(out).toContain('.butin')
    expect(out).toContain('.butin *')
    expect(out).toContain('.butin ::before')
    // The bare `*` must not remain — it would reset the whole host.
    expect(out).not.toMatch(/(^|,|})\s*\*(\s|,|{)/)
  })

  it('descendant-scopes utilities and dark-variant selectors', () => {
    const out = scopeCss('.bg-card { background: var(--card) } .dark\\:bg-card:is(.dark *) { background: black }')

    expect(out).toContain('.butin .bg-card')
    expect(out).toContain('.butin .dark\\:bg-card:is(.dark *)')
  })

  it('leaves already-scoped token blocks untouched (no double prefix)', () => {
    const out = scopeCss('.butin { --card: white } .butin.dark, .dark .butin { --card: black }')

    expect(out).toContain('.butin { --card: white }')
    expect(out).toContain('.butin.dark, .dark .butin')
    expect(out).not.toContain('.butin .butin')
  })

  it('never rewrites keyframe steps', () => {
    const out = scopeCss('@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }')

    expect(out).toContain('from {')
    expect(out).toContain('to {')
    expect(out).not.toContain('.butin from')
  })
})
