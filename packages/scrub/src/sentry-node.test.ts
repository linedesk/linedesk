import * as Sentry from '@sentry/node'
import { DrizzleQueryError } from 'drizzle-orm'
import { afterAll, expect, test } from 'vitest'
import { serverSentryOptions } from './sentry-node.ts'

afterAll(() => Sentry.close())

test('what real console lines and a real exception put on the wire: no names, notes, numbers, emails or keys', async () => {
  const sent: string[] = []
  Sentry.init({
    ...serverSentryOptions('api', { SENTRY_DSN: 'https://k@o1.ingest.us.sentry.io/1' }),
    transport: options =>
      Sentry.createTransport(options, async request => {
        sent.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body))
        return { statusCode: 200 }
      }),
  })
  const failed = new DrizzleQueryError(
    'insert into "contacts" ("name","phone","notes") values ($1, $2, $3)',
    ['Dana [VIP] Ruiz', '+15035550142', 'gate code QX-4471, dog is friendly'],
    new Error('duplicate key value violates unique constraint'),
  )
  // A raw pg error, as pg-boss logs it: the failing row in `detail`.
  const pgError = Object.assign(new Error('null value in column "phone" violates not-null constraint'), {
    code: '23502',
    detail: 'Failing row contains (ct_1, Dana Ruiz, null, gate code QX-4471).',
  })
  console.error('saving the contact failed', failed)
  console.error('job failed', pgError)
  console.error('call failed', { caller: 'Dana Ruiz', transcript: 'my gate code is QX-4471' })
  console.error({ caller: 'Dana Ruiz' }, 'plain object first')
  console.warn('sms to (503) 555-0142 for mike@example.com refused, key sk_Zk9q3TbW0aRx1mN4pLs8vYc2')
  Sentry.captureException(failed)
  await Sentry.flush(2000)

  const wire = sent.join('\n')
  expect(wire).toContain('saving the contact failed Error: Failed query: insert into')
  expect(wire).toContain('job failed Error: null value in column')
  expect(wire).toContain('call failed [object]')
  // Only markers that cannot turn up by chance: a bare 4-digit number does in about 1 run in 150, inside the
  // envelope's random ids, timestamps and memory sizes (it failed CI once that way).
  for (const secret of [
    'Dana',
    'Ruiz',
    '15035550142',
    'gate code',
    'QX-4471',
    'mike@example.com',
    'sk_Zk9q3TbW0aRx1mN4pLs8vYc2',
  ]) {
    expect(wire).not.toContain(secret)
  }
  expect(wire).not.toContain('sentry.message.parameter')
})
