import { expect, test } from 'vitest'

import { asCanvasColor } from './echarts-theme.js'

test('asCanvasColor wraps a bare HSL triplet so the canvas can parse it', () => {
  expect(asCanvasColor('0 0% 26%')).toBe('hsl(0 0% 26%)')
  expect(asCanvasColor('220 13% 50% / 40%')).toBe('hsl(220 13% 50% / 40%)')
})

test('asCanvasColor passes real color functions through unchanged', () => {
  expect(asCanvasColor('oklch(0.92 0.004 286.32)')).toBe('oklch(0.92 0.004 286.32)')
  expect(asCanvasColor('#ffffff')).toBe('#ffffff')
})
