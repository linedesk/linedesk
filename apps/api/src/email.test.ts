import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createEmailSender, senderLine, smtpCheck } from './email.ts'
import { smtpOf } from './email-services.ts'

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
      // The Resend preset's own URL, pointed at the local server: same scheme, user, key and query.
      const preset = new URL(smtpOf('resend', { api_key: 're_secret' })!.url)
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

describe('senderLine', () => {
  it('keeps a From with a name, and gives a bare or missing address the product name', () => {
    expect(senderLine('Desk <desk@example.com>')).toBe('Desk <desk@example.com>')
    expect(senderLine(' desk@example.com ')).toBe('Linedesk <desk@example.com>')
    expect(senderLine(undefined)).toBe('Linedesk <no-reply@localhost>')
  })
})
