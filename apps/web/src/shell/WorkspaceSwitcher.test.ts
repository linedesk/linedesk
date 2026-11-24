import { describe, expect, test } from 'vitest'
import { filterWorkspaces } from './WorkspaceSwitcher.tsx'

const all = [
  { id: 'w3', name: 'Cedar Dental' },
  { id: 'w1', name: 'Brightwater Plumbing' },
  { id: 'w2', name: 'Acme HVAC' },
]

describe('filterWorkspaces', () => {
  test('the current workspace first, then the others by name', () => {
    expect(filterWorkspaces(all, 'w3', '').map(w => w.id)).toEqual(['w3', 'w2', 'w1'])
  })
  test('a filter matches names case-insensitively and leaves out the current one', () => {
    expect(filterWorkspaces(all, 'w1', 'DENT').map(w => w.id)).toEqual(['w3'])
    expect(filterWorkspaces(all, 'w1', 'bright')).toEqual([])
  })
  test('blank filters show everything', () => {
    expect(filterWorkspaces(all, 'w1', '   ')).toHaveLength(3)
  })
})
