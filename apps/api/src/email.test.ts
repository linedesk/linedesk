import { createServer } from 'node:net'
import type { PgBoss } from 'pg-boss'
import { describe, expect, it, vi } from 'vitest'
import { createEmailSender, emailsKeyedByJob, senderLine, smtpCheck } from './email.ts'
import { mailConnectionOf } from './email-services.ts'

describe('createEmailSender', () => {
  it('uses SMTP when SMTP_URL is set', () => {
    expect(createEmailSender({ SMTP_URL: 'smtp://user:pass@mail.example.com:587' }).kind).toBe('smtp')
  })

  it('prints the email to the log only when EMAIL_TO_LOG is on', async () => {
    const sender = createEmailSender({ EMAIL_TO_LOG: 'true' })
    expect(sender.kind).toBe('log')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await sender.send({ to: 'mike@brightwater.example', subject: 'Hello', text: 'https://example.com/link' })
    expect(log.mock.calls[0]?.[0]).toContain('To: mike@brightwater.example')
    expect(log.mock.calls[0]?.[0]).toContain('https://example.com/link')
    log.mockRestore()
  })

  it('refuses to send when neither is set', async () => {
    const sender = createEmailSender({ NODE_ENV: 'development' })
    expect(sender.kind).toBe('none')
    await expect(sender.send({ to: 'mike@brightwater.example', subject: 'Hello', text: 'x' })).rejects.toThrow(
      /Server admin › Providers › Email/,
    )
  })

  it('leaves out email to EMAIL_MUTED_TO, without its text', async () => {
    const sender = createEmailSender({
      EMAIL_TO_LOG: 'true',
      EMAIL_MUTED_TO: ' Mike@Brightwater.example , x@y.example',
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await sender.send({ to: 'mike@brightwater.example', subject: 'Your code', text: 'code 123456' })
    expect(log.mock.calls).toHaveLength(1)
    expect(log.mock.calls[0]?.[0]).toContain('EMAIL_MUTED_TO')
    expect(log.mock.calls[0]?.[0]).not.toContain('123456')
    await sender.send({ to: 'sara@brightwater.example', subject: 'Hello', text: 'sent' })
    expect(log.mock.calls[1]?.[0]).toContain('To: sara@brightwater.example')
    log.mockRestore()
  })

  it('prefers SMTP over the log', () => {
    expect(createEmailSender({ SMTP_URL: 'smtp://mail.example.com', EMAIL_TO_LOG: 'true' }).kind).toBe('smtp')
  })

  it('gives up with a clear error when the mail server never answers', async () => {
    // Accepts the connection and then says nothing, like a firewall that swallows port 465.
    const silent = createServer(() => {})
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    const { port } = silent.address() as { port: number }
    try {
      const sender = createEmailSender(
        { SMTP_URL: `smtp://user:secret@127.0.0.1:${port}` },
        { connectMs: 200, sendMs: 1000 },
      )
      const sent = sender.send({ to: 'mike@brightwater.example', subject: 'Hello', text: 'x' })
      await expect(sent).rejects.toThrow(/Could not send email.*127\.0\.0\.1/)
      await expect(sent).rejects.not.toThrow(/secret/)
    } finally {
      silent.close()
    }
  })

  it('says port 465 may be blocked when a URL on 465 gets no answer, and only then', async () => {
    const refused = createEmailSender(
      { SMTP_URL: 'smtps://user:secret@127.0.0.1:465' },
      { connectMs: 500, sendMs: 1000 },
    )
    const sent = refused.send({ to: 'mike@brightwater.example', subject: 'Hello', text: 'x' })
    await expect(sent).rejects.toThrow(/Port 465 may be blocked by your host; try 587/)
    await expect(sent).rejects.not.toThrow(/secret/)
    expect((await smtpCheck('smtps://user:secret@127.0.0.1:465')).message).toMatch(/try 587/)
    const silent = createServer(() => {})
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    const { port } = silent.address() as { port: number }
    try {
      const other = createEmailSender({ SMTP_URL: `smtp://127.0.0.1:${port}` }, { connectMs: 200, sendMs: 1000 })
      await expect(other.send({ to: 'mike@brightwater.example', subject: 'Hello', text: 'x' })).rejects.not.toThrow(
        /Port 465/,
      )
    } finally {
      silent.close()
    }
  })

  it('a preset never logs in without TLS: a server that offers no STARTTLS gets no password', async () => {
    // Plays a mail server without STARTTLS (like a plain dev server, or an attacker stripping it) and keeps every line.
    const lines: string[] = []
    const server = createServer(socket => {
      socket.write('220 test ESMTP\r\n')
      socket.on('data', chunk => {
        for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
          lines.push(line)
          if (/^EHLO/i.test(line)) socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n')
          else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n')
          else socket.write('250 ok\r\n')
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    try {
      // The SendGrid preset's own URL, pointed at the local server: same scheme, user, key and query.
      const preset = new URL(mailConnectionOf('sendgrid', { api_key: 're_secret' })!.url)
      preset.hostname = '127.0.0.1'
      preset.port = String(port)
      const sender = createEmailSender({ SMTP_URL: preset.toString() }, { connectMs: 1000, sendMs: 3000 })
      await expect(sender.send({ to: 'mike@brightwater.example', subject: 'Hello', text: 'x' })).rejects.toThrow()
      expect(lines.some(line => /^AUTH/i.test(line))).toBe(false)
      expect(lines.join('\n')).not.toContain(Buffer.from('re_secret').toString('base64'))
    } finally {
      server.close()
    }
  })

  it('sends a message through an SMTP server', async () => {
    // A minimal SMTP server that accepts one message and keeps what it was sent.
    let received = ''
    const server = createServer(socket => {
      let inData = false
      socket.write('220 test ESMTP\r\n')
      socket.on('data', chunk => {
        const text = chunk.toString()
        if (inData) {
          received += text
          if (received.includes('\r\n.\r\n')) {
            inData = false
            socket.write('250 queued\r\n')
          }
          return
        }
        for (const line of text.split('\r\n').filter(Boolean)) {
          if (/^EHLO/i.test(line)) socket.write('250 test\r\n')
          else if (/^DATA/i.test(line)) {
            inData = true
            socket.write('354 go on\r\n')
          } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n')
          else socket.write('250 ok\r\n')
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    try {
      const sender = createEmailSender(
        { SMTP_URL: `smtp://127.0.0.1:${port}`, EMAIL_FROM: 'Linedesk <no-reply@linedesk.test>' },
        { connectMs: 1000, sendMs: 3000 },
      )
      await sender.send({ to: 'mike@brightwater.example', subject: '123456 is your code', text: 'Hello Mike' })
      expect(received).toMatch(/^From: Linedesk <no-reply@linedesk\.test>\r$/m)
      expect(received).toMatch(/^To: mike@brightwater\.example\r$/m)
      expect(received).toMatch(/^Subject: 123456 is your code\r$/m)
      expect(received).toContain('Hello Mike')
    } finally {
      server.close()
    }
  })
})

describe('createEmailSender with Resend', () => {
  const env = {
    SMTP_URL: mailConnectionOf('resend', { api_key: 're_secret_key' })!.url,
    EMAIL_FROM: 'Desk <desk@example.com>',
  }
  const resendFake = (status = 200, body: unknown = { id: 'e1' }) => {
    const requests: { url: string; init: RequestInit }[] = []
    const doFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(input), init })
      return new Response(JSON.stringify(body), { status })
    })
    return { doFetch: doFetch as unknown as typeof fetch, requests }
  }

  it('sends over the HTTPS API with the key as a bearer token: From, Reply-To, both parts and the headers', async () => {
    const fake = resendFake()
    const sender = createEmailSender(env, undefined, fake.doFetch)
    expect(sender.kind).toBe('resend')
    await sender.send({
      to: 'mike@brightwater.example',
      subject: 'Your code',
      text: 'code 123456',
      html: '<p>code 123456</p>',
      replyTo: 'help@brightwater.example',
      headers: { 'List-Unsubscribe': '<https://example.com/u>' },
    })
    expect(fake.requests).toHaveLength(1)
    const [request] = fake.requests
    expect(request!.url).toBe('https://api.resend.com/emails')
    expect(request!.init.method).toBe('POST')
    expect((request!.init.headers as Record<string, string>).authorization).toBe('Bearer re_secret_key')
    expect(JSON.parse(String(request!.init.body))).toEqual({
      from: 'Desk <desk@example.com>',
      to: ['mike@brightwater.example'],
      subject: 'Your code',
      text: 'code 123456',
      html: '<p>code 123456</p>',
      reply_to: 'help@brightwater.example',
      headers: { 'List-Unsubscribe': '<https://example.com/u>' },
    })
  })

  it('keeps muting: a muted address gets nothing and no request goes out', async () => {
    const fake = resendFake()
    const sender = createEmailSender({ ...env, EMAIL_MUTED_TO: 'mike@brightwater.example' }, undefined, fake.doFetch)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await sender.send({ to: 'Mike@Brightwater.example', subject: 'Your code', text: 'code 123456' })
    log.mockRestore()
    expect(fake.requests).toHaveLength(0)
  })

  it('a refused key fails with a message that names the fix and never the key', async () => {
    const fake = resendFake(403, { statusCode: 403, name: 'invalid_api_key', message: 'API key is invalid' })
    const sent = createEmailSender(env, undefined, fake.doFetch).send({ to: 'a@b.example', subject: 's', text: 't' })
    await expect(sent).rejects.toThrow(/Resend refused the API key \(HTTP 403\).*Server admin › Providers › Resend/)
    await expect(sent).rejects.not.toThrow(/re_secret_key/)
  })

  it('check: a sending-only key (it may not list domains) still works, a refused one does not; nothing is sent', async () => {
    const restricted = resendFake(401, { statusCode: 401, name: 'restricted_api_key', message: 'restricted' })
    expect(await createEmailSender(env, undefined, restricted.doFetch).check()).toEqual({
      ok: true,
      message: 'Sends through the Resend API (api.resend.com).',
    })
    expect(restricted.requests.map(r => `${r.init.method} ${r.url}`)).toEqual(['GET https://api.resend.com/domains'])
    const refused = resendFake(403, { name: 'invalid_api_key' })
    expect(await createEmailSender(env, undefined, refused.doFetch).check()).toMatchObject({ ok: false })
  })

  it("a job's emails carry an Idempotency-Key that its retry repeats; an email outside a job carries none", async () => {
    const fake = resendFake()
    const sender = createEmailSender(env, undefined, fake.doFetch)
    // A stand-in for pg-boss: work() keeps the handler; a run (and a retry) calls it with the same job.
    const handlers: ((jobs: unknown) => Promise<unknown>)[] = []
    const boss = {
      work: async (_name: string, handler: (jobs: unknown) => Promise<unknown>) => {
        handlers.push(handler)
        return 'w'
      },
    }
    const keyed = emailsKeyedByJob(boss as unknown as PgBoss)
    await keyed.work<{ to: string }>('notify', async ([job]) => {
      await sender.send({ to: job!.data.to, subject: 'New call', text: 'Mike called' })
    })
    const job = { id: '9a1c7a52-0000-4000-8000-000000000001', data: { to: 'mike@brightwater.example' } }
    await handlers[0]!([job])
    await handlers[0]!([job])
    await handlers[0]!([{ ...job, id: '9a1c7a52-0000-4000-8000-000000000002' }])
    await sender.send({ to: 'mike@brightwater.example', subject: 'New call', text: 'Mike called' })
    const keys = fake.requests.map(r => new Headers(r.init.headers).get('idempotency-key'))
    expect(keys[0]).toMatch(/^linedesk-[0-9a-f]{64}$/)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).toMatch(/^linedesk-/)
    expect(keys[2]).not.toBe(keys[0])
    expect(keys[3]).toBeNull()
  })

  it('the SMTP provider with a Resend SMTP URL still sends over SMTP', () => {
    expect(createEmailSender({ SMTP_URL: 'smtp://resend:re_1@smtp.resend.com:587?requireTLS=true' }).kind).toBe('smtp')
  })
})

describe('senderLine', () => {
  it('keeps a From with a name, and gives a bare or missing address the product name', () => {
    expect(senderLine('Desk <desk@example.com>')).toBe('Desk <desk@example.com>')
    expect(senderLine(' desk@example.com ')).toBe('Linedesk <desk@example.com>')
    expect(senderLine(undefined)).toBe('Linedesk <no-reply@localhost>')
  })
})
