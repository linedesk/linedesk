import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Design rule 19: icon, text and actions of a notice box share one centre line.
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const rule = (selector: string) => css.split('\n').find(line => line.startsWith(`${selector} {`)) ?? ''

describe('notice boxes', () => {
  it('centre the icon, the text and the actions vertically', () => {
    expect(rule('.k-note')).toContain('align-items: center')
    expect(rule('.k-note-action')).toContain('align-items: center')
  })

  it('do not nudge the icon or the text to fake the centring', () => {
    expect(css).not.toMatch(/\.k-note[^{]*\.k-note-icon \{[^}]*margin-top/)
    expect(css).not.toMatch(/\.k-note[^{]*\.k-note-body \{[^}]*padding-top/)
    expect(rule('.k-note-icon')).not.toContain('margin-top')
  })
})
