import type { AgentSetupState } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { AgentEndedNote, StepAction, withTestCallMade } from './AgentSetup.tsx'
import type { PasskeyHere } from './AddPasskeyStep.tsx'

type Step = AgentSetupState['progress']['steps'][number]
const step = (id: string, state: Step['state']): Step => ({ id, label: id, group: 'business', state })
const workspace = { id: 'ws_1', account: 'u_1' }
const row = (s: Step, here: typeof workspace | null = workspace, hasBusiness = true) =>
  renderToStaticMarkup(
    <StepAction
      step={s}
      passkey={{} as PasskeyHere}
      workspace={here}
      hasBusiness={hasBusiness}
      assistantName="Maya"
      onCalled={() => {}}
      reload={async () => {}}
    />,
  )

test('the test call is made right on the setup page: "Call Maya now", never "do this in the app"', () => {
  const open = row(step('test_call', 'admin_only'))
  expect(open).toMatch(/k-btn-primary[^>]*>.*Call Maya now/)
  expect(open).not.toMatch(/in the app/)
  // Done: a quiet Call again, so a call still running keeps its panel.
  const done = row(step('test_call', 'done'))
  expect(done).toContain('Call again')
  expect(done).not.toContain('k-btn-primary')
  // Before the business exists there is nothing to call yet; another tab's workspace says where it works.
  expect(row(step('test_call', 'admin_only'), null, false)).toContain('once your business is set up')
  expect(row(step('test_call', 'admin_only'), null, true)).toContain('from the tab of your first workspace')
  expect(row(step('test_call', 'done'), null)).toBe('')
})

test('call forwarding opens its settings dialog on the page while it is open; the agent steps have no action', () => {
  expect(row(step('forwarding', 'todo'))).toContain('Set up forwarding')
  expect(row(step('forwarding', 'done'))).toBe('')
  for (const id of ['answering', 'telephony', 'email', 'call-audio', 'workspace', 'business', 'phone'])
    expect(row(step(id, 'todo'))).toBe('')
})

test('a test call answered here shows the step done at once', () => {
  const steps = [step('phone', 'done'), step('test_call', 'admin_only')]
  expect(withTestCallMade(steps, false)).toEqual(steps)
  expect(withTestCallMade(steps, true)[1]).toMatchObject({ id: 'test_call', state: 'done' })
})

test('the page says when the agent ended its own access', () => {
  const at = new Date()
  at.setHours(17, 58, 0, 0)
  const html = renderToStaticMarkup(<AgentEndedNote at={at.toISOString()} />)
  expect(html).toMatch(/Your agent ended its access at 5:58\s?PM\./)
  expect(html).toContain('Create a new link any time')
})
