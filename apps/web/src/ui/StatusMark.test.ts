import { readFileSync } from 'node:fs'
import type { StatusState } from '@linedesk/actions'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { markKind, StatusMark } from './StatusMark.tsx'

const html = (state: StatusState, label?: string) => renderToStaticMarkup(createElement(StatusMark, { state, label }))

test('each state has its own shape: check, exclamation mark, cross, empty circle, spinner', () => {
  expect(markKind('works')).toBe('works')
  expect(markKind('partly')).toBe('partly')
  expect(markKind('failing')).toBe('failing')
  expect(markKind('checking')).toBe('busy')
  for (const state of ['missing', 'untested', 'not_needed', 'off'] as const) expect(markKind(state)).toBe('empty')
  // The shape is in the markup, not only the colour.
  expect(html('works')).toContain('M5 12.5l4.2 4.2L19 7')
  expect(html('failing')).toContain('M18 6 6 18M6 6l12 12')
  expect(html('partly')).toContain('>!<')
  expect(html('checking')).toContain('k-spin')
  expect(html('missing')).not.toContain('<svg')
})

test('every mark has its words as label and tooltip', () => {
  expect(html('works')).toContain('role="img" aria-label="Works" title="Works"')
  expect(html('failing')).toContain('aria-label="Failing"')
  expect(html('missing')).toContain('aria-label="Not set up"')
  expect(html('checking')).toContain('aria-label="Checking…"')
  expect(html('failing', 'Failing: Key rejected')).toContain('title="Failing: Key rejected"')
})

test('its classes are all k-mark-*: no global rule can reach it (.empty once stretched it into an oval)', () => {
  for (const state of ['works', 'partly', 'failing', 'missing', 'untested', 'off', 'checking'] as const) {
    const classes = [...html(state).matchAll(/class="([^"]*)"/g)].flatMap(m => m[1]!.split(' '))
    const own = classes.filter(c => c !== 'k-icon' && c !== 'k-spin')
    expect(own.length, state).toBeGreaterThan(0)
    for (const c of own) expect(c, state).toMatch(/^k-mark(-|$)/)
  }
})

test('the stylesheet fixes its size and never styles a bare state word', () => {
  const css = readFileSync(new URL('./status-mark.css', import.meta.url), 'utf8')
  const base = css.slice(css.indexOf('.k-mark {'), css.indexOf('}', css.indexOf('.k-mark {')))
  for (const rule of ['width: 14px', 'height: 14px', 'max-height: 14px', 'flex: none', 'padding: 0', 'margin: 0'])
    expect(base).toContain(rule)
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g) ?? []
  for (const s of selectors) expect(s.trim(), s).toMatch(/^\.k-mark/)
})
