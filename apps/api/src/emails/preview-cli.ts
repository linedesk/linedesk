// Writes every email to HTML and text files to look at (and screenshot), and with --send sends
// each one to an address through the configured sender (SMTP_URL, or the log).
// --brand renders them as an install with its own product name (Server admin › Branding), --hide-powered-by with the
// "Powered by Linedesk" line switched off.
//   pnpm --filter @linedesk/api email:preview [--out <dir>] [--send <address>] [--brand <name>] [--hide-powered-by]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { setBrandingInMemory } from '../branding.ts'
import { previewEmails } from './previews.ts'
import { WEB_ORIGIN } from './templates.ts'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'email-previews' },
    send: { type: 'string' },
    brand: { type: 'string' },
    'hide-powered-by': { type: 'boolean', default: false },
  },
})
if (values.brand) setBrandingInMemory({ name: values.brand, poweredBy: !values['hide-powered-by'] })
const out = resolve(values.out!)
mkdirSync(out, { recursive: true })
const previews = previewEmails(WEB_ORIGIN)
for (const { name, email } of previews) {
  writeFileSync(join(out, `${name}.html`), email.html)
  writeFileSync(join(out, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}`)
}
const links = previews.map(
  ({ name, email }) =>
    `<li><a href="${name}.html">${name}</a> · <a href="${name}.txt">text</a> — ${email.subject.replaceAll('<', '&lt;')}</li>`,
)
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Linedesk emails</title><ul>${links.join('')}</ul>`,
)
console.log(`Wrote ${previews.length} emails to ${out}`)

if (values.send) {
  const { emailSender } = await import('../email.ts')
  for (const { name, email } of previews) {
    await emailSender.send({ to: values.send, ...email })
    console.log(`sent ${name}`)
  }
}
