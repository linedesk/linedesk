// Server texts in the reader's language (LIN-385, slice 1): refusals are written in the caller's language, the command
// log keeps their English, and stored texts (a forwarding check's detail) are written when they are read.
import { commands, user as users } from '@linedesk/db'
import { getT } from '@linedesk/i18n/server'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { personActor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { detailText, tryAgain } from '../src/forwarding-check.ts'
import { Forbidden, Reject, rejectionText, said, sayIn } from '../src/handler-context.ts'
import { testAnswer } from '../src/provider-test.ts'
import { runAction } from '../src/run-action.ts'
import { urlProblemSaid } from '../src/webhooks.ts'
import { act, createWorkspace } from './helpers.ts'

/** The pseudo-locale: every translated word is accented and inside ⟦ ⟧, so English left over shows. */
const pseudo = getT('en-XA')
const english = getT('en')

describe('refusals in the reader’s language', () => {
  test('Reject.t: English as its message, the reader’s words in rejectionText; params written for the reader', () => {
    const e = Reject.t('server.api.alreadyContact', { phone: '+15035550100' })
    expect(e.message).toBe('+15035550100 is already a contact')
    expect(rejectionText(e, pseudo)).toMatch(/^⟦.*\+15035550100.*⟧$/)
    expect(Forbidden.t('server.api.assistantCannotAssign')).toBeInstanceOf(Forbidden)
    // A param that is words: written in the reader's language when the text is.
    const lazy = said('server.api.voicesCantSpeak', { languages: reader => reader.format.list(['A', 'B']) })
    expect(sayIn(lazy)).toBe("The voice providers set up can't speak A and B: pick another language")
    // A rejection written as text stays as it is in every language.
    expect(rejectionText(new Reject('as it came'), pseudo)).toBe('as it came')
  })

  test('the answer is in the caller’s language, the command log keeps the English', async () => {
    const ws = await createWorkspace('Texts')
    const member = await personActor(ws.owner.userId, ws.id, [], ['account:own'], { sessionId: 's' })
    const reader = { ...member!, locale: 'en-XA' as never }
    const commandId = crypto.randomUUID()
    const res = await runAction('call.assign', { callId: ws.call.id, userId: 'nobody' }, reader, commandId)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ ok: false, error: expect.stringMatching(/^⟦.*⟧$/) })
    const [logged] = await db.select().from(commands).where(eq(commands.id, commandId))
    expect(logged?.result).toMatchObject({ ok: false, error: 'that user is not a member of this workspace' })
  })

  test('a member’s own language, else English', async () => {
    const ws = await createWorkspace('Texts language')
    await db.update(users).set({ locale: 'de' }).where(eq(users.id, ws.owner.userId))
    const res = await act(ws.owner, 'call.assign', { callId: ws.call.id, userId: 'nobody' })
    expect(res).toMatchObject({ status: 409, body: { error: getT('de').t('server.api.notAMember') } })
    const [row] = await db
      .select({ result: commands.result })
      .from(commands)
      .where(and(eq(commands.workspace_id, ws.id), eq(commands.action, 'call.assign')))
    expect(row?.result).toMatchObject({ error: english.t('server.api.notAMember') })
  })

  test('team, webhook and calendar refusals answer in the caller’s language (LIN-371)', async () => {
    const ws = await createWorkspace('Texts team')
    const member = await personActor(ws.owner.userId, ws.id, [], ['account:own'], { sessionId: 's' })
    const reader = { ...member!, locale: 'en-XA' as never }
    const res = await runAction('team.transferOwnership', { memberId: 'nobody' }, reader, crypto.randomUUID())
    expect(res.body).toMatchObject({ ok: false, error: expect.stringMatching(/^⟦.*⟧$/) })
    // A webhook address's reason, with a list written in the reader's words.
    const port = await urlProblemSaid('https://93.184.215.14:22/hook', {})
    expect(sayIn(port!)).toBe('Use port 443 or 8443.')
    expect(sayIn(port!, pseudo)).toMatch(/^⟦.*443.*8443.*⟧$/)
  })
})

describe('stored and returned texts', () => {
  test('a forwarding check’s detail is stored as a key and written for each reader', () => {
    const stored = JSON.stringify(said('server.api.forwardingCheck.forwardsElsewhere', { linedesk: '+1 503 555 0100' }))
    expect(detailText(stored)).toBe('Your phone forwards to another number, not to +1 503 555 0100.')
    expect(detailText(stored, pseudo)).toMatch(/^⟦.*\+1 503 555 0100.*⟧$/)
    // Rows from before keys, and no detail, as they are.
    expect(detailText('Could not check: the call could not be placed.', pseudo)).toBe(
      'Could not check: the call could not be placed.',
    )
    expect(detailText('{not json', pseudo)).toBe('{not json')
    expect(detailText(null)).toBeNull()
  })

  test('tryAgain counts the hours in the reader’s words', () => {
    const now = Date.now()
    expect(tryAgain(now - 2 * 3600_000, now)).toBe('Try again in about 22 hours.')
    expect(tryAgain(now - 2 * 3600_000, now, pseudo)).toMatch(/^⟦.*22.*⟧$/)
  })

  test('a provider test answers in the reader’s language and keeps its English without the key', () => {
    const tested = {
      ok: true,
      status: 'ok' as const,
      message: 'Connected, balance 12.00 USD',
      said: said('server.api.providerTest.connectedBalance', { amount: '12.00 USD' }),
    }
    expect(testAnswer(tested)).toEqual({ ok: true, status: 'ok', message: 'Connected, balance 12.00 USD' })
    expect(testAnswer(tested, pseudo).message).toMatch(/^⟦.*12\.00 USD.*⟧$/)
  })
})
