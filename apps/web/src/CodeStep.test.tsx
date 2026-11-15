import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { CodeStep } from './Login.tsx'

const html = (props: { supportEmail?: string | null; invited?: boolean } = {}) =>
  renderToStaticMarkup(
    <CodeStep email="dana@brightwater.example" onDone={async () => {}} onDifferentEmail={() => {}} {...props} />,
  )

test('the code step says the same for every address: never whether it has an account', () => {
  const out = html()
  expect(out).toContain('If dana@brightwater.example can sign in here')
  expect(out).toContain(
    'No code after a minute? Check your spam folder. If this address has no account here, ask your workspace admin for an invitation.',
  )
  expect(out).not.toMatch(/No account for this email/)
  expect(out).not.toContain('mailto:')
})

test('the support address is named under the code when the install sets one', () => {
  const out = html({ supportEmail: 'support@brightwater.example' })
  expect(out).toContain(
    'Or write to <a class="k-link" href="mailto:support@brightwater.example">support@brightwater.example</a>.',
  )
})

test('from an invitation the line does not send them to ask for one', () => {
  const out = html({ invited: true, supportEmail: 'support@brightwater.example' })
  expect(out).toContain('No code after a minute? Check your spam folder.')
  expect(out).not.toMatch(/invitation/)
  expect(out).toContain('mailto:support@brightwater.example')
})
