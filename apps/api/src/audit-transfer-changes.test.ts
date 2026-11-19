// What the audit log says about a change of transfer contacts (transferChanges, audit.ts).
import { defaultTransfers } from '@linedesk/db/types'
import { describe, expect, test } from 'vitest'
import { transferChanges } from './audit.ts'

const owner = defaultTransfers()[0]!
const sarah = { ...owner, id: 'sarah', name: 'Sarah Lee', number: '+15035550142', briefing: true }

describe('transferChanges', () => {
  test('adding a contact next to the default one, saved with briefing on, names only the new contact', () => {
    // The settings page saves every contact with `briefing` set; the default contact has none (missing: on).
    const changes = transferChanges([owner], [{ ...owner, briefing: true }, sarah])
    expect(changes?.added.map(c => c.name)).toEqual(['Sarah Lee'])
    expect(changes?.changed).toEqual([])
  })

  test('turning the briefing off is a change', () => {
    const changes = transferChanges([owner], [{ ...owner, briefing: false }])
    expect(changes?.changed.map(c => c.fields)).toEqual([['briefing']])
  })

  test('saving the same list with briefing set is no change at all', () => {
    expect(transferChanges([owner], [{ ...owner, briefing: true }])).toBeNull()
  })
})
