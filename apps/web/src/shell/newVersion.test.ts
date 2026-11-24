import { describe, expect, it } from 'vitest'
import { entryScriptOf, isNewVersion } from './newVersion.ts'

const page = (hash: string) =>
  `<html><head><script type="module" crossorigin src="/assets/index-${hash}.js"></script><link rel="stylesheet" href="/assets/index-${hash}.css"></head></html>`

describe('new version check', () => {
  it('reads the entry script from index.html', () => {
    expect(entryScriptOf(page('abc'))).toBe('/assets/index-abc.js')
    expect(entryScriptOf('<script type="module" src="/src/main.tsx"></script>')).toBeNull()
  })
  it('is new only when the served entry script differs from the running one', () => {
    expect(isNewVersion('/assets/index-abc.js', page('abc'))).toBe(false)
    expect(isNewVersion('/assets/index-abc.js', page('def'))).toBe(true)
  })
  it('never claims a new version without something to compare', () => {
    expect(isNewVersion(null, page('def'))).toBe(false)
    expect(isNewVersion('/assets/index-abc.js', '<html>maintenance</html>')).toBe(false)
  })
})
