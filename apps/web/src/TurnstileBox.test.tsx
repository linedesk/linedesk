import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { TurnstileBox } from './Signup.tsx'

// The sign-up page's bot check (Cloudflare Turnstile): the widget has its own fixed width, so its box centers it in
// the column like the field and the button around it. It shows only when Cloudflare needs the person
// (interaction-only), so no room is kept for it, and its box gives back the column's gap while nothing shows.
const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
/** The declarations of the first rule with exactly this selector. */
const rule = (selector: string) => {
  const start = css.indexOf(`\n${selector} {`)
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
}

test('both sign-up steps render the bot check through the one centered box', () => {
  const page = readFileSync(new URL('./Signup.tsx', import.meta.url), 'utf8')
  expect(page.match(/<TurnstileBox bot=\{bot\} \/>/g)).toHaveLength(2)
  expect(page).not.toMatch(/className="auth-turnstile"/)
  expect(renderToStaticMarkup(<TurnstileBox bot={{ box: { current: null }, collapsed: false }} />)).toBe(
    '<div class="auth-turnstile"></div>',
  )
  expect(renderToStaticMarkup(<TurnstileBox bot={{ box: { current: null }, collapsed: true }} />)).toBe(
    '<div class="auth-turnstile is-collapsed"></div>',
  )
})

test('the widget is centered at its own height, with no room kept while nothing shows', () => {
  const box = rule('.auth-turnstile')
  expect(box).toMatch(/display: flex;/)
  expect(box).toMatch(/justify-content: center;/)
  // Not stretched to the kept height: an invisible widget measures 0 tall.
  expect(box).toMatch(/align-items: flex-start;/)
  expect(box).not.toMatch(/min-height/)
  const collapsed = rule('.auth-turnstile.is-collapsed')
  const page = readFileSync(new URL('./Signup.tsx', import.meta.url), 'utf8')
  expect(page).toMatch(/appearance: 'interaction-only'/)
  // Gives back the column's gap, so the button sits where it would without a bot check.
  const gap = /gap: (\d+)px;/.exec(rule('.auth-form'))?.[1]
  expect(gap).toBe('12')
  expect(collapsed).toMatch(new RegExp(`margin-bottom: -${gap}px;`))
})
