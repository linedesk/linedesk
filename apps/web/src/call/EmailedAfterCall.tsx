// "Emailed after the call" in the call view's side panel (LIN-369): who got the email about this call (calls.email_route),
// the reason the assistant's call email instruction gave, whom it assigned the call to, or why it went to everyone with
// call emails on instead. Links to the assistant's Call emails section to change it.
import type { Call, EmailRoute } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useAssistants } from '../store.tsx'
import { memberLabel, useMember } from '../team/members.ts'
import { parseTs, timeLabel } from '../time.ts'
import { AppLink } from '../ui/AppLink.tsx'
import { RecipientChips } from '../settings/CallEmails.tsx'
import '../settings/call-emails.css'

const FALLBACK_TEXT: Record<NonNullable<EmailRoute['problem']>, MessageKey> = {
  no_llm: msg('call.emailed.fallback.no_llm'),
  llm_failed: msg('call.emailed.fallback.llm_failed'),
  nothing_fit: msg('call.emailed.fallback.nothing_fit'),
}

export function EmailedAfterCall({ call }: { call: Call }) {
  const t = useT()
  const route = call.email_route
  const assistant = useAssistants().find(a => a.id === call.assistant_id)
  const assignee = useMember(route?.assigned_user_id ?? null)
  if (!route) return null
  const assistantName = assistant?.name.trim() || t('call.emailed.theAssistant')
  return (
    <div className="side-sec ce-sent">
      <div className="ce-sent-head">
        <h2>{t('call.emailed.title')}</h2>
        <span className="mono">{timeLabel(parseTs(route.at))}</span>
      </div>
      <RecipientChips to={route.to} />
      {!route.to.length && <span className="help">{t('call.emailed.nobody')}</span>}
      {route.mode === 'routed' && route.reason && <blockquote className="ce-quote">{route.reason}</blockquote>}
      {route.assigned_user_id && (
        <span className="help">
          {t('call.emailed.assigned', { member: memberLabel(assignee), assistant: assistantName })}
        </span>
      )}
      {route.mode === 'fallback' && (
        <span className="help">
          {route.problem ? t(FALLBACK_TEXT[route.problem]) : t('call.emailed.fallback.other')}
        </span>
      )}
      {call.assistant_id && (
        <span className="help">
          <AppLink to={`#assistant/${call.assistant_id}/emails`}>{t('call.emailed.change')}</AppLink>
        </span>
      )}
    </div>
  )
}
