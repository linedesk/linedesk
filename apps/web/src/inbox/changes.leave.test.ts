import type { Call } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { deleteChange, doneChange, preview } from './changes.ts'

const call = { id: 'c1', status: 'completed', inbox_state: 'open', outcome: 'callback', urgency: 'normal', unread: false, reminder_at: null, deleted_at: null } as Call

describe('what a change does to the row', () => {
  it('marks a deleted call as deleted, so it leaves every view (also search and an open call)', () => {
    expect(preview(call, deleteChange(call).steps).deleted_at).toBeTruthy()
    expect(preview(call, doneChange(call).steps).deleted_at).toBeNull()
  })
})
