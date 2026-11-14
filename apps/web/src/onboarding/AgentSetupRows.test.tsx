import type { AgentSetupState } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import {
  AgentEndedNote,
  NEW_WORKSPACE,
  StepAction,
  WorkspacePicker,
  withTestCallMade,
  workspaceOptions,
} from './AgentSetup.tsx'
import type { PasskeyHere } from './AddPasskeyStep.tsx'

type Step = AgentSetupState['progress']['steps'][number]
const step = (id: string, state: Step['state']): Step => ({ id, label: id, group: 'business', state })
const workspace = { id: 'ws_1', account: 'u_1' }
/** One row's action: `here` is the workspace shown when it is this tab's; `onSwitch` when it is another one. */
const row = (s: Step, here: typeof workspace | null = workspace, onSwitch: (() => void) | null = null) =>
  renderToStaticMarkup(
    <StepAction
      step={s}
      passkey={{} as PasskeyHere}
      workspace={here}
      onSwitch={onSwitch}
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
  // Before the workspace exists there is nothing to call yet.
  expect(row(step('test_call', 'admin_only'), null)).toContain('once the workspace exists')
  expect(row(step('test_call', 'done'), null)).toBe('')
})

test('the buttons always act on the workspace shown: another than the active one is opened first, never hidden (LIN-237)', () => {
  const switchTo = () => {}
  const call = row(step('test_call', 'admin_only'), null, switchTo)
  expect(call).toMatch(/k-btn-primary[^>]*>.*Call Maya now/)
  expect(call).toContain('Opens this workspace in this tab first')
  expect(call).not.toMatch(/tab of your first workspace/)
  const forwarding = row(step('forwarding', 'todo'), null, switchTo)
  expect(forwarding).toContain('Set up forwarding')
  expect(forwarding).toContain('Opens this workspace in this tab first')
  expect(row(step('forwarding', 'done'), null, switchTo)).toBe('')
  expect(row(step('test_call', 'done'), null, switchTo)).toBe('')
})

test('the workspace dropdown lists every workspace with how far it got, and New workspace… last (LIN-237)', () => {
  const two = [
    { id: 'ws_1', name: 'Brightwater Plumbing & Heating', done: 8, total: 8 },
    { id: 'ws_2', name: 'Brightwater Salem', done: 2, total: 8 },
  ]
  expect(workspaceOptions(two)).toEqual([
    { value: 'ws_1', label: 'Brightwater Plumbing & Heating', description: 'Set up' },
    { value: 'ws_2', label: 'Brightwater Salem', description: '2 of 8 done' },
    { value: NEW_WORKSPACE, label: 'New workspace…', description: 'Another business or location' },
  ])
  // None yet: said so, and a new one can be made right here.
  expect(workspaceOptions([]).map(o => o.label)).toEqual(['No workspace yet', 'New workspace…'])
  // The dropdown heads the workspace steps and shows the picked one; while switching it waits.
  const html = renderToStaticMarkup(
    <WorkspacePicker workspaces={two} selectedId="ws_2" busy={null} onPick={() => {}} />,
  )
  expect(html).toContain('id="as-group-business"')
  expect(html).toMatch(/aria-label="Workspace whose steps are shown: Brightwater Salem"/)
  expect(html).not.toMatch(/<button[^>]*disabled/)
  const busy = renderToStaticMarkup(
    <WorkspacePicker workspaces={two} selectedId="ws_2" busy="ws_1" onPick={() => {}} />,
  )
  expect(busy).toMatch(/<button[^>]*disabled/)
  expect(busy).toContain('Brightwater Plumbing &amp; Heating')
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
