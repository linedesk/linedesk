// "Emailed after the call" in the call view's side panel (LIN-369, LIN-470): one quiet line with who got the email
// about this call (calls.email_route), what the call email rules that fit are about and whom it assigned the call to; a "?" shows the
// language model's reason. In fallback mode, why (the rules could not be matched). Links to the assistant's
// Call emails section to change it. Names are the ones stored with the route, so a former member keeps theirs.
import type { Call, EmailRoute } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { memberLabel, useMember } from '../team/members.ts'
import { parseTs, timeLabel } from '../time.ts'
import { AppLink } from '../ui/AppLink.tsx'
import { HelpTip } from '../ui/HelpTip.tsx'
import '../settings/call-emails.css'

const FALLBACK_TEXT: Record<NonNullable<EmailRoute['problem']>, MessageKey> = {
  no_llm: msg('call.emailed.fallback.no_llm'),
  llm_failed: msg('call.emailed.fallback.llm_failed'),
  nothing_fit: msg('call.emailed.fallback.nothing_fit'),
}

export function EmailedAfterCall({ call }: { call: Call }) {
  const t = useT()
  const format = useFormat()
  const route = call.email_route
  const assignee = useMember(route?.assigned_user_id ?? null)
  if (!route) return null
  const names = route.to.map(r => r.name)
  const topics = route.mode === 'routed' ? (route.rules ?? []) : []
  const parts = [
    t('call.emailed.to', { names: format.list(names) }),
    ...(topics.length ? [t('call.emailed.about', { topics: format.list(topics) })] : []),
    ...(route.assigned_user_id ? [t('call.emailed.assignedTo', { member: memberLabel(assignee) })] : []),
  ]
  return (
    <div className="side-sec ce-sent">
      <div className="ce-sent-head">
        <h2>{t('call.emailed.title')}</h2>
        <span className="mono">{timeLabel(parseTs(route.at))}</span>
      </div>
      {route.to.length ? (
        <p className="ce-sent-line">
          {parts.join(' · ')}
          {route.mode === 'routed' && route.reason && <HelpTip label={t('call.emailed.why')} text={route.reason} />}
        </p>
      ) : (
        <span className="help">{t('call.emailed.nobody')}</span>
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
