import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StatusState } from '@linedesk/actions'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { icons } from './icons.ts'
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
  expect(html('partly')).toContain('M12 5v7.5M12 19h.01')
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

/** The corners a path's lines pass through (M, L, H, V, absolute and relative): enough for the glyphs' straight strokes. */
function pathPoints(d: string): [number, number][] {
  const points: [number, number][] = []
  let x = 0
  let y = 0
  for (const [, cmd, args] of d.matchAll(/([MLHVmlhv])([^MLHVmlhv]*)/g)) {
    const n = (args!.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number)
    const rel = cmd === cmd!.toLowerCase()
    const c = cmd!.toUpperCase()
    for (let i = 0; i < n.length; ) {
      if (c === 'H') x = (rel ? x : 0) + n[i++]!
      else if (c === 'V') y = (rel ? y : 0) + n[i++]!
      else {
        x = (rel ? x : 0) + n[i++]!
        y = (rel ? y : 0) + n[i++]!
      }
      points.push([x, y])
    }
  }
  return points
}

test('every glyph drawn in a circle has its ink centred on the icon box, so the circle centres the ink', () => {
  // Round caps and joins add half the stroke on every side alike, so the corners' box centre is the ink's centre.
  for (const name of ['check', 'close', 'exclamation'] as const) {
    const points = icons[name].flatMap(([tag, attrs]) => (tag === 'path' ? pathPoints(String(attrs.d)) : []))
    const xs = points.map(p => p[0])
    const ys = points.map(p => p[1])
    expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 12), name).toBeLessThanOrEqual(0.2)
    expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - 12), name).toBeLessThanOrEqual(0.2)
  }
})

test('the glyph stroke is the same on screen at any size', () => {
  const css = readFileSync(new URL('./status-mark.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.k-mark-glyph \{[^}]*stroke-width: 1\.25px;/)
  expect(css).toMatch(/\.k-mark-glyph > \* \{[^}]*vector-effect: non-scaling-stroke;/)
})

const src = fileURLToPath(new URL('..', import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })

test('no circled mark draws a text character: its glyph is MarkGlyph (a text "!" sat a pixel low)', () => {
  const marks = /<span className="(?:as-mark|adm-try-mark|golive-mark|k-mark)[^"]*"[^>]*(?<!\/)>([\s\S]*?)<\/span>/g
  let found = 0
  for (const file of sources(src)) {
    for (const [, inside] of readFileSync(file, 'utf8').matchAll(marks)) {
      found++
      const rest = inside!.replace(/<MarkGlyph[^>]*\/>/g, '').replace(/<Spinner \/>/g, '')
      // Only expressions that choose a glyph or nothing may stay: no quoted string, no bare text.
      expect(rest, file).not.toMatch(/['"`][^'"`]*['"`]\s*(?:\)|:|\}|$)/)
      expect(rest.replace(/\{[\s\S]*\}/g, '').trim(), file).toBe('')
    }
  }
  expect(found).toBeGreaterThanOrEqual(4)
})
