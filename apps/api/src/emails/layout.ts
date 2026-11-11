// The one layout every email uses: a template describes its content as blocks, and this file turns
// them into an HTML part and a plain-text part that say the same thing. Templates never write HTML,
// so every string they pass is escaped here. Table-based with inline styles for Outlook and Gmail,
// a <style> block only for dark mode and narrow screens. No images, fonts or tracking: the mark is
// drawn with table cells.

export type Block =
  | { kind: 'text'; text: string; tone?: 'muted' }
  /** A one-time code, large and monospaced. */
  | { kind: 'code'; code: string }
  | { kind: 'button'; label: string; url: string }
  /** Label and value rows, in a quiet box when titled ("Booked"). */
  | { kind: 'facts'; title?: string; rows: [label: string, value: string][] }
  | { kind: 'list'; title: string; items: string[] }

export type EmailContent = {
  subject: string
  /** The line inbox lists show after the subject. */
  preheader: string
  /** Emails to callers carry the business's name instead of the Linedesk mark. */
  business?: string
  /** A small line above the heading ("Maya answered · Tue 9:00 AM · 3 min"). */
  eyebrow?: string
  /** A red badge next to the eyebrow; only for urgent things. */
  urgent?: string
  heading: string
  blocks: Block[]
  /** Why the recipient got this email, and where to change it when they can. */
  reason: string
  settings?: { label: string; url: string }
  /** The install's address (WEB_ORIGIN); its host names the site in the footer. */
  origin: string
}

export type RenderedEmail = { subject: string; text: string; html: string }

const INK = '#1C1917'
const MUTED = '#645D57'
const LINE = '#E7E4DE'
const PAPER = '#FAFAF8'
const SOFT = '#F3F2EE'
const LIVE = '#22C55E'
const DANGER = '#B42318'
const DANGER_SOFT = '#FDECEA'
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Caller text (names, summaries) is untrusted: a caller can say "visit pay-here.example" and the
 * summary repeats it. A zero-width space after the dot and in "://" keeps mail apps from turning
 * it into a link, in both parts. Numbers like 3.50 are left alone.
 */
export function defuseLinks(value: string): string {
  return value.replace(/:\/\//g, ':/​/').replace(/([\p{L}\p{N}-])\.(?=\p{L}{2,})/gu, '$1.​')
}

/** Only web links; anything else is a bug in the template. */
function checkedUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) throw new Error(`email link must be http(s): ${url}`)
  return url
}

export function siteHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

const paragraphs = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>')

// ---------------------------------------------------------------- HTML

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'text': {
      const muted = block.tone === 'muted'
      return `<p class="${muted ? 'ld-muted' : 'ld-ink'}" style="margin:0 0 16px;font-size:${muted ? 14 : 16}px;line-height:1.55;color:${muted ? MUTED : INK};">${paragraphs(block.text)}</p>`
    }
    case 'code':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 20px;"><tr><td class="ld-soft ld-ink" align="center" style="background:${SOFT};border-radius:10px;padding:20px 12px;font-family:${MONO};font-size:34px;line-height:1;font-weight:600;letter-spacing:8px;color:${INK};">${escapeHtml(block.code)}</td></tr></table>`
    case 'button': {
      const url = escapeHtml(checkedUrl(block.url))
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td class="ld-btn" align="center" bgcolor="${INK}" style="border-radius:8px;background:${INK};"><a class="ld-btn-text" href="${url}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1.2;color:${PAPER};text-decoration:none;border-radius:8px;">${escapeHtml(block.label)}</a></td></tr></table>`
    }
    case 'facts': {
      const rows = block.rows
        .map(
          ([label, value]) =>
            `<tr><td class="ld-muted" valign="top" style="padding:4px 16px 4px 0;font-size:14px;line-height:1.45;color:${MUTED};white-space:nowrap;width:1%;">${escapeHtml(label)}</td><td class="ld-ink" valign="top" style="padding:4px 0;font-size:15px;line-height:1.45;color:${INK};">${paragraphs(value)}</td></tr>`,
        )
        .join('')
      const table = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>`
      if (!block.title) return `<div style="margin:0 0 20px;">${table}</div>`
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;"><tr><td class="ld-soft" style="background:${SOFT};border-radius:10px;padding:14px 16px;">${sectionTitle(block.title)}${table}</td></tr></table>`
    }
    case 'list': {
      const items = block.items
        .map(
          item =>
            `<tr><td class="ld-muted" valign="top" style="padding:3px 10px 3px 0;font-size:15px;line-height:1.5;color:${MUTED};width:1%;">&bull;</td><td class="ld-ink" valign="top" style="padding:3px 0;font-size:15px;line-height:1.5;color:${INK};">${escapeHtml(item)}</td></tr>`,
        )
        .join('')
      return `<div style="margin:0 0 20px;">${sectionTitle(block.title)}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${items}</table></div>`
    }
  }
}

const sectionTitle = (title: string) =>
  `<p class="ld-muted" style="margin:0 0 6px;font-size:12px;line-height:1.4;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">${escapeHtml(title)}</p>`

/** The lit line key: a rounded outline, a green light and a label line, all table cells. */
const MARK = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;vertical-align:middle;"><tr><td class="ld-key" style="border:2px solid ${INK};border-radius:9px;padding:4px 6px;line-height:0;font-size:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="ld-key-light" width="8" height="8" bgcolor="${LIVE}" style="width:8px;height:8px;border-radius:4px;background:${LIVE};font-size:0;line-height:0;">&nbsp;</td><td width="4" style="width:4px;font-size:0;line-height:0;">&nbsp;</td><td valign="middle" style="font-size:0;line-height:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="ld-key-line" width="12" height="2" bgcolor="${INK}" style="width:12px;height:2px;border-radius:1px;background:${INK};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table></td></tr></table>`

function headerHtml(business: string | undefined): string {
  if (business) {
    return `<span class="ld-ink" style="font-size:16px;font-weight:600;color:${INK};">${escapeHtml(business)}</span>`
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle">${MARK}</td><td valign="middle" class="ld-ink" style="padding-left:10px;font-family:${MONO};font-size:16px;font-weight:600;letter-spacing:-0.04em;color:${INK};">linedesk</td></tr></table>`
}

const STYLE = `
:root{color-scheme:light dark;supported-color-schemes:light dark;}
body{margin:0;padding:0;-webkit-text-size-adjust:100%;}
a{color:${INK};}
@media (max-width:600px){
  .ld-outer{padding:12px 8px !important;}
  .ld-pad{padding:24px 20px !important;}
  .ld-heading{font-size:22px !important;}
}
@media (prefers-color-scheme:dark){
  .ld-bg{background:#0F0E0D !important;}
  .ld-card{background:#1C1917 !important;border-color:#2E2A27 !important;}
  .ld-ink{color:#F5F4F1 !important;}
  .ld-muted{color:#A8A29E !important;}
  .ld-muted a{color:#D6D3D1 !important;}
  .ld-soft{background:#292524 !important;}
  .ld-rule{border-color:#2E2A27 !important;}
  .ld-btn{background:#F5F4F1 !important;}
  .ld-btn-text{color:#1C1917 !important;}
  .ld-key{border-color:#F5F4F1 !important;}
  .ld-key-line{background:#F5F4F1 !important;}
  .ld-key-light{background:#4ADE80 !important;}
  .ld-badge{background:#4A1512 !important;color:#FCA5A5 !important;}
}`

function eyebrowHtml(content: EmailContent): string {
  if (!content.eyebrow && !content.urgent) return ''
  const badge = content.urgent
    ? `<span class="ld-badge" style="display:inline-block;padding:2px 8px;margin-right:8px;border-radius:999px;background:${DANGER_SOFT};color:${DANGER};font-size:12px;font-weight:600;line-height:1.5;">${escapeHtml(content.urgent)}</span>`
    : ''
  const eyebrow = content.eyebrow ? `<span>${escapeHtml(content.eyebrow)}</span>` : ''
  return `<p class="ld-muted" style="margin:0 0 10px;font-size:13px;line-height:1.5;color:${MUTED};">${badge}${eyebrow}</p>`
}

function footerHtml(content: EmailContent): string {
  const settings = content.settings
    ? ` <a href="${escapeHtml(checkedUrl(content.settings.url))}" target="_blank" style="color:${MUTED};text-decoration:underline;">${escapeHtml(content.settings.label)}</a>`
    : ''
  const sentBy = content.business ? `Sent for ${content.business} by Linedesk` : 'Linedesk'
  return `<p style="margin:0 0 6px;">${escapeHtml(content.reason)}${settings}</p><p style="margin:0;">${escapeHtml(sentBy)} &middot; ${escapeHtml(siteHost(content.origin))}</p>`
}

function renderHtml(content: EmailContent): string {
  const preheader = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAPER};opacity:0;">${escapeHtml(content.preheader)}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(content.subject)}</title>
<style>${STYLE}</style>
</head>
<body class="ld-bg" style="margin:0;padding:0;background:${PAPER};">
${preheader}
<table role="presentation" class="ld-bg" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${PAPER}" style="background:${PAPER};">
<tr><td class="ld-outer" align="center" style="padding:32px 16px;font-family:${FONT};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">
<tr><td style="padding:0 4px 16px;font-family:${FONT};">${headerHtml(content.business)}</td></tr>
<tr><td class="ld-card ld-pad" bgcolor="#FFFFFF" style="background:#FFFFFF;border:1px solid ${LINE};border-radius:14px;padding:32px;font-family:${FONT};">
${eyebrowHtml(content)}<h1 class="ld-ink ld-heading" style="margin:0 0 20px;font-size:24px;line-height:1.25;font-weight:650;letter-spacing:-0.01em;color:${INK};">${escapeHtml(content.heading)}</h1>
${content.blocks.map(blockHtml).join('\n')}
</td></tr>
<tr><td class="ld-muted" style="padding:20px 4px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">${footerHtml(content)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`
}

// ---------------------------------------------------------------- plain text

function blockText(block: Block): string {
  switch (block.kind) {
    case 'text':
      return block.text
    case 'code':
      return `    ${block.code}`
    case 'button':
      return `${block.label}:\n${checkedUrl(block.url)}`
    case 'facts': {
      const rows = block.rows.map(([label, value]) => `${label}: ${value}`).join('\n')
      return block.title ? `${block.title}\n${rows}` : rows
    }
    case 'list':
      return `${block.title}\n${block.items.map(item => `- ${item}`).join('\n')}`
  }
}

function renderText(content: EmailContent): string {
  const top = [content.urgent?.toUpperCase(), content.eyebrow].filter(Boolean).join(' · ')
  const settings = content.settings ? ` ${content.settings.label}: ${checkedUrl(content.settings.url)}` : ''
  const sentBy = content.business ? `Sent for ${content.business} by Linedesk` : 'Linedesk'
  const parts = [
    ...(top ? [top] : []),
    content.heading,
    ...content.blocks.map(blockText),
    '--',
    `${content.reason}${settings}`,
    `${sentBy} · ${siteHost(content.origin)}`,
  ]
  return `${parts.join('\n\n')}\n`
}

export function renderEmail(content: EmailContent): RenderedEmail {
  // One line: a header with a line break in it would be refused or split.
  const subject = content.subject.replace(/\s+/g, ' ').trim()
  return { subject, text: renderText(content), html: renderHtml({ ...content, subject }) }
}
