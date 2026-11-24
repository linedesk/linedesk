import { expect, test } from 'vitest'
import { declaredCharset, decodePage } from './page-text.ts'

const latin1 = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'))
const utf8 = (s: string) => Uint8Array.from(Buffer.from(s, 'utf8'))
const R = String.fromCharCode(0xfffd)

test('the charset comes from the header, else from a meta tag', () => {
  expect(declaredCharset('text/html; charset="ISO-8859-1"', utf8(''))).toBe('ISO-8859-1')
  expect(declaredCharset('text/html', latin1('<meta charset="windows-1252">'))).toBe('windows-1252')
  expect(
    declaredCharset('text/html', latin1('<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">')),
  ).toBe('shift_jis')
  expect(declaredCharset('text/html', utf8('<p>hi</p>'))).toBe('')
})

test('a German page in ISO-8859-1 keeps its umlauts, also when it names no charset or the wrong one', () => {
  const page = '<p>Gespräch, Größe, Straße</p>'
  expect(decodePage(latin1(page), 'text/html; charset=iso-8859-1')).toBe(page)
  expect(decodePage(latin1(`<meta charset="iso-8859-1">${page}`), 'text/html')).toContain(page)
  expect(decodePage(latin1(page), 'text/html')).toBe(page)
  expect(decodePage(latin1(page), 'text/html; charset=utf-8')).toBe(page)
})

test('UTF-8 pages in any script stay whole; a cut letter at the end is dropped, not replaced', () => {
  const page = 'Gespräch 日本語 Привет مرحبا 👋'
  expect(decodePage(utf8(page), 'text/html; charset=utf-8')).toBe(page)
  expect(decodePage(utf8(page), '')).toBe(page)
  const cut = utf8(page).subarray(0, utf8(page).length - 2)
  const text = decodePage(cut, 'text/html', true)
  expect(text).not.toContain(R)
  expect(page.startsWith(text)).toBe(true)
  expect(decodePage(utf8(page), 'text/html; charset=x-unknown')).toBe(page)
})
