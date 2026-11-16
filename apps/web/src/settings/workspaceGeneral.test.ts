import { WORKSPACE_NAME_MAX } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { renameCheck, saveRename } from './workspaceGeneral.ts'

const saved = 'Brightwater Plumbing & Heating'

test('an unchanged name, also with spaces around it, saves nothing and is no problem', () => {
  expect(renameCheck(saved, saved)).toEqual({ next: saved, changed: false, problem: null })
  expect(renameCheck(`  ${saved} `, saved)).toEqual({ next: saved, changed: false, problem: null })
})

test('a new name is saved trimmed', () => {
  expect(renameCheck('  Brightwater Plumbing  ', saved)).toEqual({
    next: 'Brightwater Plumbing',
    changed: true,
    problem: null,
  })
  expect(renameCheck('x'.repeat(WORKSPACE_NAME_MAX), saved).problem).toBeNull()
})

test('the workspace name rules of workspace.rename block the save', () => {
  expect(renameCheck('   ', saved).problem).toBe('Enter the business name.')
  expect(renameCheck('x'.repeat(WORKSPACE_NAME_MAX + 1), saved).problem).toMatch(/characters at most/)
  for (const bad of ['Two\nlines', 'Rtl ‮gnirts', 'Nul\u0000'])
    expect(renameCheck(bad, saved).problem, JSON.stringify(bad)).toBe(
      'The name must be one line, without control characters.',
    )
})

test('a new name shows only once it is saved; a refusal puts the saved one back and says why', async () => {
  const shown: string[] = []
  const steps = (write: (name: string) => Promise<unknown>) => ({
    write,
    saved: (name: string) => shown.push(`saved ${name}`),
    refused: (reason: string) => shown.push(`refused ${reason}`),
  })
  let sent: string | null = null
  const pending = saveRename('Brightwater Plumbing', steps(async name => (sent = name)))
  expect(shown).toEqual([]) // nothing on screen before the server answered
  await pending
  expect(sent).toBe('Brightwater Plumbing')
  await saveRename('Brightwater X', steps(async () => Promise.reject(new Error('Not possible while signed in as another user.'))))
  expect(shown).toEqual(['saved Brightwater Plumbing', 'refused Not possible while signed in as another user.'])
})
