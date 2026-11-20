import { expect, test } from 'vitest'
import { dropLoggedObjects, maskPhoneNumbers, scrubEvent, scrubLog, scrubPath, scrubText } from './index.ts'

test('phone numbers are masked to their last two digits, in every US and international form', () => {
  expect(maskPhoneNumbers('call from +15035550142 failed')).toBe('call from [phone …42] failed')
  expect(maskPhoneNumbers('dial (503) 555-0142 now')).toBe('dial [phone …42] now')
  expect(maskPhoneNumbers('dial 503-555-0142 or 503.555.0142')).toBe('dial [phone …42] or [phone …42]')
  expect(maskPhoneNumbers('local 555-0142')).toBe('local [phone …42]')
  expect(maskPhoneNumbers('bare 5035550142')).toBe('bare [phone …42]')
  expect(maskPhoneNumbers('+49 151 23456789')).toBe('[phone …89]')
})

test('national numbers with a trunk 0 and international ones with 00 are masked too', () => {
  expect(maskPhoneNumbers('call 06221 5550147 now')).toBe('call [phone …47] now')
  expect(maskPhoneNumbers('call 06221/5550147 now')).toBe('call [phone …47] now')
  expect(maskPhoneNumbers('call 030-1234567 now')).toBe('call [phone …67] now')
  expect(maskPhoneNumbers('call 0049 6221 5550147 now')).toBe('call [phone …47] now')
  expect(maskPhoneNumbers('version 0.1.40, port 05190, at 2026-11-20')).toBe(
    'version 0.1.40, port 05190, at 2026-11-20',
  )
})

test('timestamps, IPs, ports and ids are not phone numbers', () => {
  const text =
    'at 2026-11-14 10:22:33 from 192.168.10.200:5432 for call_19b89a11d2324ebc9a22 and llk_0b4d4e8f9a7b1c2d3e4f5a6b3f2a9c1e'
  expect(maskPhoneNumbers(text)).toBe(text)
  expect(scrubText(text)).toBe(text)
})

test('secrets go first: keys, passwords, enrolment codes, S3 secret keys, long digit runs inside tokens', () => {
  expect(scrubText('code Zk9_q3TbW0aRx1mN4pLs8vYc used')).toBe('code [token] used') // 18 bytes base64url
  expect(scrubText('secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok')).toBe('secret [token] ok')
  expect(scrubText('sig 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe('sig [token]')
  expect(scrubText('link abc123456789012345xyzABC done')).toBe('link [token] done')
  expect(scrubText('signed QmFzZTY0K2tleT0ve+/=AAAAAAAAAAAAAAAA end')).toBe('signed [token] end')
  // Not our id shapes: an sk_ key with 32 hex, a UUID-shaped secret.
  expect(scrubText('key sk_0b4d4e8f9a7b1c2d3e4f5a6b3f2a9c1e')).toBe('key [token]')
  expect(scrubText('secret 3f2a9c1e-0b4d-4e8f-9a7b-1c2d3e4f5a6b')).toBe('secret [token]')
})

test('our own ids, paths and long words stay readable', () => {
  expect(scrubText('call call_19b89a11d2324ebc9a22 ended')).toBe('call call_19b89a11d2324ebc9a22 ended')
  expect(scrubText('GET /v1/calls/call_19b89a11d2324ebc9a22/recording')).toBe(
    'GET /v1/calls/call_19b89a11d2324ebc9a22/recording',
  )
  expect(scrubText('TelnyxOutboundProfileMissingError: provider_settings_not_configured')).toBe(
    'TelnyxOutboundProfileMissingError: provider_settings_not_configured',
  )
})

test('a failed drizzle query loses its params, in a message and in an error JSON-stringified for a log line', () => {
  const message =
    'Failed query: insert into "contacts" ("name","phone") values ($1, $2)\nparams: Dana Ruiz,+15035550142'
  expect(scrubText(message)).toBe('Failed query: insert into "contacts" ("name","phone") values ($1, $2)')
  const logged = `saving failed ${JSON.stringify({ name: 'DrizzleQueryError', message, stack: `DrizzleQueryError: x\n    at saveContact (contacts.ts:12:5)`, params: ['Dana [VIP] Ruiz', 'note'] })}`
  expect(scrubLog({ message: logged }).message).toBe(
    'saving failed DrizzleQueryError: Failed query: insert into "contacts" ("name","phone") values ($1, $2)',
  )
})

test('an event keeps the stack and the member, scrubs every exception and the message, drops the rest', () => {
  const event = scrubEvent({
    message: 'note from mike@example.com',
    transaction: 'GET /mcp/setup/sk_live_abcdefghijklmnopqrstuvwxyz012345',
    request: { method: 'GET', url: 'https://app.example.com/mcp/setup/sk_live_abc123?x=1' },
    user: { id: 'u_1', email: 'mike@example.com', username: 'Mike' },
    exception: {
      values: [
        { value: 'duplicate key value violates unique constraint' },
        { value: 'Failed query: insert into "contacts" values ($1)\nparams: Dana Ruiz' },
        { value: 'refused for +1 (503) 555-0142 with key 6f1c2b7e9a0d4c8b1f3e5a7c9d0b2e4f6a8c0e2d' },
      ],
    },
    breadcrumbs: [{ message: 'Dana Ruiz' }],
    extra: { input: { phone: '+15035550142' } },
  })
  expect(event.exception?.values?.map(e => e.value)).toEqual([
    'duplicate key value violates unique constraint',
    'Failed query: insert into "contacts" values ($1)',
    'refused for [phone …42] with key [token]',
  ])
  expect(event.message).toBe('note from [email]')
  expect(event.transaction).toBe('GET /mcp/setup/[key]')
  expect(event.request).toEqual({ method: 'GET', url: 'https://app.example.com/mcp/setup/[key]' })
  expect(event.user).toEqual({ id: 'u_1', email: 'mike@example.com', username: 'Mike' })
  expect(event.breadcrumbs).toBeUndefined()
  expect(event.extra).toBeUndefined()
})

test('paths lose query, fragment and secret segments, not ids', () => {
  expect(scrubPath('/v1/calls/call_19b89a11d2324ebc9a22/recording?t=1#x')).toBe(
    '/v1/calls/call_19b89a11d2324ebc9a22/recording',
  )
  expect(scrubPath('/files/Zk9_q3TbW0aRx1mN4pLs8vYc/download')).toBe('/files/[key]/download')
})

test('a log line keeps the scrubbed message, the template and the member, not the console arguments', () => {
  const log = scrubLog({
    message: 'transfer to +15035550167 refused',
    attributes: {
      'sentry.origin': 'auto.log.console',
      'sentry.message.template': 'transfer to {} refused',
      'sentry.message.parameter.0': '+15035550167',
      'user.id': '9f86d081884c7d659a2feaa0c55ad015',
      'user.email': 'mike@example.com',
      'user.name': 'Mike',
      caller: 'Dana Ruiz',
    },
  })
  expect(log.message).toBe('transfer to [phone …67] refused')
  expect(log.attributes).toEqual({
    'sentry.origin': 'auto.log.console',
    'sentry.message.template': 'transfer to {} refused',
    'user.id': '9f86d081884c7d659a2feaa0c55ad015',
    'user.email': 'mike@example.com',
    'user.name': 'Mike',
  })
})

test('every object logged in a line is replaced; an error keeps only its name and message', () => {
  expect(dropLoggedObjects('{"caller":"Dana Ruiz","note":"a } b"} plain object first')).toBe(
    '[object] plain object first',
  )
  expect(dropLoggedObjects('call failed {"caller":"Dana Ruiz","transcript":"my gate code is 4471"}')).toBe(
    'call failed [object]',
  )
  expect(dropLoggedObjects('ids [1,{"a":"x"}] and {"b":["]"]} end')).toBe('ids [object] and [object] end')
  expect(dropLoggedObjects('cut off {"caller":"Dana')).toBe('cut off [object]')
  const pgError = JSON.stringify({
    message: 'null value in column "phone" violates not-null constraint',
    name: 'error',
    stack: 'error: null value…\n    at Parser.parseErrorMessage (pg-protocol/dist/parser.js:285:98)',
    detail: 'Failing row contains (ct_1, Dana Ruiz, null, gate code 4471).',
  })
  expect(dropLoggedObjects(`job failed ${pgError}`)).toBe(
    'job failed error: null value in column "phone" violates not-null constraint',
  )
})

test('a contact or a caller message is not an error: name and message without a stack trace are dropped', () => {
  expect(dropLoggedObjects('could not save {"name":"Dana Ruiz","message":"my gate code is 4471"}')).toBe(
    'could not save [object]',
  )
  expect(dropLoggedObjects('could not save {"name":"Dana Ruiz","message":"x","stack":"Dana Ruiz"}')).toBe(
    'could not save [object]',
  )
})

test('values Postgres quotes in its messages are replaced', () => {
  expect(scrubText('invalid input syntax for type uuid: "Dana Ruiz"')).toBe(
    'invalid input syntax for type uuid: "[value]"',
  )
  expect(scrubText('invalid input value for enum call_status: "Dana"')).toBe(
    'invalid input value for enum call_status: "[value]"',
  )
  expect(scrubText('malformed array literal: "{Dana \\"VIP\\" Ruiz}"')).toBe('malformed array literal: "[value]"')
  expect(scrubText('date/time field value out of range: "2026-13-45"')).toBe(
    'date/time field value out of range: "[value]"',
  )
})

test('the log template loses logged objects too', () => {
  const log = scrubLog({
    message: 'x',
    attributes: { 'sentry.message.template': 'saving {"name":"Dana Ruiz"} failed {}' },
  })
  expect(log.attributes?.['sentry.message.template']).toBe('saving [object] failed {}')
})

test("a setup key inside Claude's install link is scrubbed, encoded or not", () => {
  const key = 'lds_fakeSetupKey0123456789abcdefghijklmnopqrstu'
  const url = `https://desk.example.com/mcp/setup/${key}`
  const link = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Linedesk%20setup&connectorUrl=${encodeURIComponent(url)}`
  for (const text of [`opened ${link}`, `copied ${url}`]) expect(scrubText(text)).not.toContain(key.slice(4))
})
