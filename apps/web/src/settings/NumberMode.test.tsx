// Settings › Phone numbers › Manage: "How calls reach <assistant>" names the number's assistant, says in one line what
// the picked mode does, and its "?" explains every mode (who dials which number, what rings, when to pick it).
import { phoneNumberModes } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { numberModeLabel } from '../onboarding/flow.ts'
import { NumberModeField, NumberModeHelp } from './NumberMode.tsx'

const field = (mode: (typeof phoneNumberModes)[number], disabled = false) =>
  renderToStaticMarkup(<NumberModeField mode={mode} name="Maya" disabled={disabled} onChange={() => {}} />)

// The text a screen reader or a person reads: tags out, entities back.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

describe('the field', () => {
  test("the label names the number's assistant, not a fixed name", () => {
    expect(text(field('new'))).toContain('How calls reach Maya')
    const other = renderToStaticMarkup(<NumberModeField mode="new" name="Leo" disabled={false} onChange={() => {}} />)
    expect(text(other)).toContain('How calls reach Leo')
    expect(other).not.toContain('Maya')
  })

  test('the "?" is a button with its own name for screen readers, closed until asked', () => {
    const html = field('forward_conditional')
    expect(html).toMatch(/<button[^>]*class="k-help-btn"[^>]*aria-label="About how calls reach Maya"/)
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('role="dialog"')
  })

  test('one line under the label says what the picked mode does', () => {
    expect(text(field('forward_conditional'))).toContain('You answer first. Calls you miss go to Maya.')
    expect(text(field('forward_all'))).toContain("Your phone doesn't ring. Every call goes to Maya.")
    expect(text(field('new'))).toContain('Customers dial this number. Your other number rings as before.')
    expect(text(field('ported'))).toContain('Customers dial your own number and Maya answers.')
  })

  test('the picked mode shows by the words of what it does', () => {
    expect(text(field('forward_all'))).toContain('Your number forwards every call')
    expect(text(field('new'))).toContain('Customers call this number directly')
  })
})

describe('the explanation behind the "?"', () => {
  const help = text(renderToStaticMarkup(<NumberModeHelp name="Maya" />))

  test('lists every mode by the same words as the select, in its order', () => {
    const at = phoneNumberModes.map(mode => help.indexOf(numberModeLabel[mode]))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test('says for each mode which number customers dial, what rings and when to pick it', () => {
    expect(help).toContain('Customers dial your business number and it rings you first.')
    expect(help).toContain('forward here to Maya; callers never see this number. Pick this to keep answering yourself.')
    expect(help).toContain(
      "Customers dial your business number, but it doesn't ring you: every call forwards here to Maya",
    )
    expect(help).toContain('Pick this when Maya should take all calls.')
    expect(help).toContain('Customers dial this number itself')
    expect(help).toContain('Your other number rings as it does today. Pick this for a separate line.')
    expect(help).toContain('Customers dial it as always and Maya answers, with no forwarding.')
    expect(help).toContain('Pick this only once the move is done.')
  })

  test('says that changing it does not reroute calls', () => {
    expect(help).toContain("Changing this here doesn't reroute any calls.")
  })

  test('no key shows instead of words', () => {
    expect(help).not.toMatch(/settings\.phone|onboarding\.flow/)
  })
})
