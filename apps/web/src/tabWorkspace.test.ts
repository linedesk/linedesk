import { expect, test } from 'vitest'
import { announceSwitch, onSwitchElsewhere } from './tabWorkspace.ts'

const settle = () => new Promise(r => setTimeout(r, 20))

test('a switch in this page is not reported as a switch in another tab', async () => {
  const seen: string[] = []
  const stop = onSwitchElsewhere(id => seen.push(id))
  announceSwitch('ws_1')
  await settle()
  stop()
  expect(seen).toEqual([])
})

test('a switch from another page is reported', async () => {
  const seen: string[] = []
  const stop = onSwitchElsewhere(id => seen.push(id))
  const other = new BroadcastChannel('linedesk-session')
  other.postMessage({ type: 'switched', workspaceId: 'ws_2', from: 'other-page' })
  await settle()
  other.close()
  stop()
  expect(seen).toEqual(['ws_2'])
})
