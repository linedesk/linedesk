import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { ConfirmByName, copyName } from './ConfirmByName.tsx'
import { typedMatches } from './DangerConfirmDialog.tsx'

const NAME = 'Acme Plumbing GmbH - Heating & Hot Water Notdienst für Hausbesitzer'
// The field as DangerConfirmDialog renders it for a `typed` confirmation (the dialog itself needs a page to render).
const html = (name: string) =>
  renderToStaticMarkup(<ConfirmByName id="danger-confirm-typed" name={name} value="" onChange={() => {}} />)

describe('type the name to confirm', () => {
  test('a label bound to the field says what to type, the name in quotes and emphasized', () => {
    const out = html(NAME)
    const escaped = NAME.replace(/&/g, '&amp;')
    expect(out).toContain(
      `<label for="danger-confirm-typed">Type “<b class="confirm-name-value">${escaped}</b>” to confirm</label>`,
    )
    expect(out).toMatch(/<input[^>]*id="danger-confirm-typed"/)
    // No placeholder standing in for the label.
    expect(out).not.toMatch(/<input[^>]*id="danger-confirm-typed"[^>]*placeholder=/)
  })

  test('a Copy button sits right next to the name', () => {
    expect(html(NAME)).toMatch(
      /<\/label><button type="button" title="Copy" aria-label="Copy the name" class="[^"]*confirm-name-copy"/,
    )
  })

  test('Copy puts the exact name on the clipboard, nothing trimmed or added', async () => {
    const written: string[] = []
    const name = '  Brightwater  Brokers '
    expect(await copyName(name, { writeText: async text => void written.push(text) })).toBe('copied')
    expect(written).toEqual([name])
    expect(await copyName(name, { writeText: async () => Promise.reject(new Error('denied')) })).toBe('failed')
  })

  test('the confirming button stays disabled until the name matches (DangerConfirmDialog unlocks it with typedMatches)', () => {
    expect(typedMatches('', NAME)).toBe(false)
    expect(typedMatches('Acme Plumbing GmbH', NAME)).toBe(false)
    expect(typedMatches(NAME, NAME)).toBe(true)
    // Case and outer spaces aside, as the API checks it (a paste with a trailing space still counts).
    expect(typedMatches(` ${NAME.toUpperCase()} `, NAME)).toBe(true)
  })
})
