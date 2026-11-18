// A partner's team setting up a client workspace reads the client's words in the onboarding (clientWords.tsx; Janik,
// 2026-11-18); the client's own owner still reads "Your …".
import en from '@linedesk/i18n/locales/en/onboarding.json'
import { useT } from '@linedesk/i18n/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { CLIENT_WORDS, clientWord, ForClient, useClientWord } from './clientWords.tsx'
import { stepLabelKeys } from './flow.ts'

function Heading() {
  const t = useT()
  const word = useClientWord()
  return (
    <p>
      {t(word(stepLabelKeys.business))} | {t(word(stepLabelKeys.assistant))} | {t(word(stepLabelKeys.pickup))} |{' '}
      {t(word('onboarding.business.heading'))}
    </p>
  )
}
const page = (forClient: boolean) => renderToStaticMarkup(<ForClient value={forClient}>{<Heading />}</ForClient>)

test("the partner's team: the client's business and assistant", () => {
  expect(page(true)).toBe(
    '<p>Client&#x27;s business | Client&#x27;s assistant | When to pick up | Tell us about the client&#x27;s business.</p>',
  )
})

test("the client's own owner (and anyone without the partner flag): your business and assistant", () => {
  expect(page(false)).toBe('<p>Business | Your assistant | When to pick up | Tell us about your business.</p>')
  expect(renderToStaticMarkup(<Heading />)).toBe(page(false))
})

test('every client word is an English text of its own, never "your"', () => {
  const texts = en as Record<string, string>
  for (const [own, client] of CLIENT_WORDS) {
    const text = texts[client.replace(/^onboarding\./, '')]
    expect(text, client).toBeTruthy()
    expect(text).not.toMatch(/\byour\b/i)
    expect(clientWord(own, true)).toBe(client)
    expect(clientWord(own, false)).toBe(own)
  }
})
