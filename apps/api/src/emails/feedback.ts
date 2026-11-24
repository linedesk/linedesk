// The email a feedback report (feedback.send, LIN-639) sends to the Linedesk team (FEEDBACK_EMAIL): what the sender
// wrote and where, and which install, workspace and sender it came from, by id. Never the sender's own address unless
// they gave one to be answered at. Everything the sender or their browser wrote is already masked (feedback.ts) and
// goes in as text with its links defused; the words around it come from packages/i18n/locales/en/email.json.
import type { FeedbackKind } from '@linedesk/actions'
import { getT } from '@linedesk/i18n/server'
import { type Block, defuseLinks, type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import { emailSafeName, type EmailLocale } from './templates.ts'

export type FeedbackReport = {
  id: string
  kind: FeedbackKind
  text: string
  page: string | null
  context: { version?: string; browser?: string; errors?: string } | null
  hasScreenshot: boolean
  contactEmail: string | null
  workspace: { id: string; name: string | null }
  sender: { actorId: string; via: string; client: string | null }
  /** The install's web address (WEB_ORIGIN) and the server's release (SENTRY_RELEASE), null when unknown. */
  origin: string
  serverVersion: string | null
}

/** The subject's summary: the text's first line, at most 80 characters. */
export function feedbackSummary(text: string): string {
  const line = (text.split(/\r?\n/).find(l => l.trim()) ?? '').replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export function feedbackEmail(report: FeedbackReport, locale?: EmailLocale): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const none = t('email.feedback.none')
  // i18n-dynamic: email.feedback.kind.*
  const kind = t(`email.feedback.kind.${report.kind}`)
  const subject = t('email.feedback.subject', { kind, summary: defuseLinks(feedbackSummary(report.text)) })
  const workspaceName = emailSafeName(report.workspace.name, none)
  const sender = report.sender.client
    ? t('email.feedback.senderWithClient', {
        actor: report.sender.actorId,
        via: report.sender.via,
        client: defuseLinks(report.sender.client),
      })
    : t('email.feedback.sender', { actor: report.sender.actorId, via: report.sender.via })
  const context = report.context ?? {}
  const blocks: Block[] = [
    { kind: 'text', text: defuseLinks(report.text) },
    {
      kind: 'facts',
      rows: [
        [t('email.feedback.label.id'), report.id],
        [t('email.feedback.label.page'), report.page ? defuseLinks(report.page) : none],
        [t('email.feedback.label.workspace'), `${workspaceName} (${report.workspace.id})`],
        [t('email.feedback.label.sender'), sender],
        [t('email.feedback.label.contact'), report.contactEmail ?? t('email.feedback.noContact')],
        [t('email.feedback.label.server'), siteHost(report.origin)],
        [t('email.feedback.label.serverVersion'), report.serverVersion ?? none],
        [t('email.feedback.label.appVersion'), context.version ? defuseLinks(context.version) : none],
        [t('email.feedback.label.browser'), context.browser ? defuseLinks(context.browser) : none],
        [t('email.feedback.label.screenshot'), report.hasScreenshot ? t('email.feedback.screenshotAttached') : none],
      ],
    },
    ...(context.errors
      ? [
          {
            kind: 'list',
            title: t('email.feedback.errors'),
            items: defuseLinks(context.errors)
              .split(/\r?\n/)
              .filter(line => line.trim()),
          } as Block,
        ]
      : []),
  ]
  return renderEmail({
    locale: lang,
    subject,
    preheader: feedbackSummary(report.text),
    eyebrow: t('email.feedback.eyebrow', { kind }),
    heading: subject,
    blocks,
    reason: t('email.feedback.reason', { site: siteHost(report.origin) }),
    origin: report.origin,
  })
}
