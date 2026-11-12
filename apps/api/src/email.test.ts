import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createEmailSender } from './email.ts'

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
      /Admin, Providers, Email/,
    )
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
