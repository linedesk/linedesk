// The link standard (docs/design-principles.md, rule 18), checked over the web app's source: a place in the
// app named inside text is an AppLink (ui/AppLink.tsx), an action inside text a LinkButton, and nothing else builds
// the link look by hand, so there is one style and one way to open a place.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'

const SRC = join(import.meta.dirname, '..')

function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative(SRC, path)] : []
  })
}
const files = sources().map(path => ({ path, text: readFileSync(join(SRC, path), 'utf8') }))
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

/**
 * Where the `k-link` class may be written by hand: the component itself, and links that leave the app (they are not a
 * place in it, but look the same): the support address on the sign-in page, a provider's key page in Server admin.
 */
const OWN_LINK_LOOK = new Set(['ui/AppLink.tsx', 'Login.tsx', 'admin/ProviderDialog.tsx'])

test('the link look comes from AppLink or LinkButton, never a hand-made class', () => {
  const found = files
    .filter(f => !OWN_LINK_LOOK.has(f.path) && /className=["{][^"}]*\bk-link\b/.test(code(f.text)))
    .map(f => f.path)
  expect(found, 'Use AppLink (a place in the app) or LinkButton (an action) from ui/AppLink.tsx').toEqual([])
})

test('a place named in a message is rendered by appLink or adminLink, not an <a> written in the tag', () => {
  const inAppTag = /chunks\s*=>\s*\(?\s*<a\b[^>]*href=(["'`{]+)#/
  const found = files.filter(f => inAppTag.test(code(f.text))).map(f => f.path)
  expect(found, "values={{ link: appLink('#…') }} (ui/AppLink.tsx)").toEqual([])
})
