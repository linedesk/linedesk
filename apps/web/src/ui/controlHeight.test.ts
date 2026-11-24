import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// LIN-202: text fields, date fields, selects and buttons take their height from one set of tokens, so controls in
// one row line up; and every date field shows its day in English through DateInput, never the browser's format.
const src = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(src, path), 'utf8')

/** The height a rule sets, from the first rule with exactly this selector. */
function heightOf(css: string, selector: string): string | undefined {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return undefined
  const body = css.slice(start, css.indexOf('}', start))
  return /(?:^|[\s;{])height:\s*([^;]+);/.exec(body)?.[1]?.trim()
}

test('controls take their height from the control tokens', () => {
  const styles = read('styles.css')
  const controls = read('ui/controls.css')
  expect(styles).toMatch(/--control-h-sm: 28px; --control-h: 32px; --control-h-lg: 36px;/)
  expect(heightOf(styles, '.k-btn')).toBe('var(--control-h)')
  expect(heightOf(styles, '.k-btn-sm')).toBe('var(--control-h-sm)')
  expect(heightOf(styles, '.k-input')).toBe('var(--control-h)')
  expect(heightOf(styles, '.k-input-sm')).toBe('var(--control-h-sm)')
  expect(heightOf(controls, '.k-select-btn')).toBe('var(--control-h)')
  expect(heightOf(controls, '.k-select-sm .k-select-btn')).toBe('var(--control-h-sm)')
})

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

test('every date field is a DateInput, so it never shows the browser format ("tt.mm.jjjj")', () => {
  const plain = files(src).filter(
    path => !path.endsWith(join('ui', 'form.tsx')) && /type="date"/.test(readFileSync(path, 'utf8')),
  )
  expect(plain.map(path => path.slice(src.length))).toEqual([])
})

test('the More voices filter row is one height: the search is small like its selects and button', () => {
  const voices = read('settings/VoiceSettings.tsx')
  const tools = voices.slice(voices.indexOf('className="vp-tools"'), voices.indexOf('Show all languages'))
  expect(tools).toMatch(/id="vp-search"\s+size="sm"/)
  expect(tools).toMatch(/<Select[^>]*?size="sm"/s)
  expect(tools).toMatch(/<Button\s+size="sm"/)
})
