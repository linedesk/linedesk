import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { CodeStep, NoCodeHint } from './Login.tsx'

const html = (props: { supportEmail?: string | null; invited?: boolean } = {}) =>
  renderToStaticMarkup(
    <CodeStep email="dana@brightwater.example" onDone={async () => {}} onDifferentEmail={() => {}} {...props} />,
  )

test('the code step says the same short line for every address: never whether it has an account', () => {
  const out = html()
  expect(out).toContain('If dana@brightwater.example has an account, we sent it a code.')
  expect(out).not.toMatch(/No account for this email/)
  // The page stays short: no link-button explanation or expiry (the email says it expires in 10 minutes).
  expect(out).not.toMatch(/expire|button in this browser/)
})

test('right after sending: Resend waits with a countdown next to "Use a different email", the spam hint is not shown yet', () => {
  const out = html({ supportEmail: 'support@brightwater.example' })
  expect(out).toMatch(
    /<div class="auth-links"><button type="button" class="auth-switch" disabled="">Resend in 30 s<\/button><button[^>]*>Use a different email<\/button><\/div>/,
  )
  // The live region is empty during the countdown, so it is announced once, when Resend opens.
  expect(out).toContain('<span class="sr-only" role="status"></span>')
  expect(out).not.toMatch(/No email\?|spam|mailto:/)
})

test('from an invitation the address may sign in: the line says plainly that the code was sent', () => {
  expect(html({ invited: true })).toContain('We sent a code to dana@brightwater.example.')
})

test('the hint after a minute: spam, or ask for an invitation, with the support address when the install sets one', () => {
  expect(renderToStaticMarkup(<NoCodeHint />)).toBe(
    '<div class="auth-notes"><p class="auth-note">No email? Check spam, or ask your workspace admin for an invitation.</p></div>',
  )
  expect(renderToStaticMarkup(<NoCodeHint supportEmail="support@brightwater.example" />)).toBe(
    '<div class="auth-notes"><p class="auth-note">No email? Check spam, or ask your workspace admin for an invitation.</p>' +
      '<p class="auth-note">Need help? Write to <a class="k-link" href="mailto:support@brightwater.example">support@brightwater.example</a></p></div>',
  )
})

test('the hint from an invitation does not send them to ask for one', () => {
  const out = renderToStaticMarkup(<NoCodeHint invited supportEmail="support@brightwater.example" />)
  expect(out).toContain('No email? Check spam.')
  expect(out).not.toMatch(/invitation/)
  expect(out).toContain('mailto:support@brightwater.example')
})
