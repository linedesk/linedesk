// Expired Better Auth verification rows (codes, passkey challenges) are deleted by the daily job (verifications.ts).
import { verification } from '@linedesk/db'
import { inArray } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { pruneExpiredVerifications } from '../src/verifications.ts'

test('deletes the expired rows and keeps the ones still valid', async () => {
  const now = new Date()
  const row = (id: string, expiresAt: Date) => ({ id, identifier: `test-${id}`, value: 'x', expiresAt })
  const tag = crypto.randomUUID().slice(0, 8)
  const ids = { old: `old-${tag}`, justExpired: `just-${tag}`, valid: `valid-${tag}` }
  await db
    .insert(verification)
    .values([
      row(ids.old, new Date(now.getTime() - 86_400_000)),
      row(ids.justExpired, new Date(now.getTime() - 1000)),
      row(ids.valid, new Date(now.getTime() + 600_000)),
    ])
  expect(await pruneExpiredVerifications(db, now)).toBeGreaterThanOrEqual(2)
  const left = await db
    .select({ id: verification.id })
    .from(verification)
    .where(inArray(verification.id, Object.values(ids)))
  expect(left.map(r => r.id)).toEqual([ids.valid])
})
