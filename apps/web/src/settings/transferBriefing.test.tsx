// Settings › Assistant › Transfers: each contact's "Announce the caller first" switch. On (the default), the consent
// hint about the AI-voice briefing shows; off, no hint, only what changes, and the row says the call goes straight through.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import type { TransferDraft } from './assistantDraft.ts'

vi.mock('./BusinessHoursDialog.tsx', () => ({ EditBusinessHours: () => null }))
vi.mock('../ui/PhoneInput.tsx', () => ({ PhoneInput: () => null }))

const { ContactRow } = await import('./TransferContacts.tsx')

const contact = (over: Partial<TransferDraft> = {}): TransferDraft => ({
  id: 'tc_1',
  name: 'Mike',
  number: '+1 503 555 0199',
  condition: 'The caller asks for a person',
  hours_only: false,
  ring_seconds: 25,
  if_no_answer: 'message',
  enabled: true,
  briefing: true,
  ...over,
})

const noop = () => {}
const render = (c: TransferDraft, open = true, isNew = false) =>
  renderToStaticMarkup(
    <ContactRow
      contact={c}
      isNew={isNew}
      index={0}
      count={1}
      open={open}
      problem={null}
      hoursOn={false}
      numberTip=""
      defaultCountry="US"
      onToggle={noop}
      onClose={noop}
      onLeave={noop}
      onChange={noop}
      onMove={noop}
      onRemove={noop}
    />,
  )

const CONSENT = 'Only add someone who agreed to get transferred calls. Each one starts with a short AI-voice briefing.'

test('briefing on: the switch is checked and the consent hint shows', () => {
  const html = render(contact())
  expect(html).toContain('Announce the caller first')
  expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""[^>]*>[\s\S]*Announce the caller first/)
  expect(html).toContain(CONSENT)
  expect(html).not.toContain('put straight through')
})

test('briefing off: no consent hint, the row says what changes and that the call goes straight through', () => {
  const html = render(contact({ briefing: false }))
  expect(html).not.toContain(CONSENT)
  expect(html).toContain('Calls are put straight through when they pick up.')
  expect(html).toContain(', put straight through')
  // Closed, the row's summary still says it.
  expect(render(contact({ briefing: false }), false)).toContain('Rings 25s, then a message, put straight through')
})

test('a contact just added: a Remove next to Done, no status yet, a placeholder that reads as an example', () => {
  const blank = contact({ name: '', number: '', condition: '' })
  const html = render(blank, true, true)
  expect(html).toMatch(/>Remove<\/span><\/button><button[^>]*><span>Done</)
  expect(html).not.toContain('Add a number to use it')
  expect(html).toContain('placeholder="e.g. Office"')
  // A contact already in the list keeps only the trash button and says why it is not used.
  const saved = render(blank, true, false)
  expect(saved).not.toContain('>Remove</span>')
  expect(saved).toContain('Add a number to use it')
})
