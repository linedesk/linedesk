import { createDb } from '@linedesk/db'
import { expect, test, vi } from 'vitest'

test('an idle connection that drops is logged, not a crash of the whole process', async () => {
  const { pool } = createDb('postgres://nobody@127.0.0.1:1/none')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  // What pg emits when an idle client's connection ends: with no listener, emit() itself would throw.
  expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Connection terminated unexpectedly'))
  log.mockRestore()
  await pool.end()
})
