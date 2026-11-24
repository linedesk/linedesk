// Server admin › Call quality › Flagged calls: the calls the evaluation flagged (Missed something, Went wrong) across workspaces,
// newest first, each with the reviewer's notes on what the assistant did, filtered by workspace. Staff only: what the
// assistant itself did wrong is ours to fix, so the business never sees it (it sees the open questions in Business info). Read-only.
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { ScoreBadge } from '../review/ScoreBadge.tsx'
import { listTime, parseTs } from '../time.ts'
import { AppLink } from '../ui/AppLink.tsx'
import { Select } from '../ui/controls.tsx'
import { Card } from '../ui/form.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import { type CallReview, loadCallReviews } from './api.ts'
import '../settings/knowledge.css'
import '../review/review.css'

const ALL = 'all'

/** The call in its own workspace, in a new tab (`?ws=` switches to it when the viewer is a member there). */
const callHref = (r: CallReview) => `#call/${encodeURIComponent(r.call_id)}?ws=${encodeURIComponent(r.workspace_id)}`

export function CallReviews() {
  const t = useT()
  const [workspace, setWorkspace] = useState<string>(ALL)
  const query = useQuery(`admin.callReviews.${workspace}`, () => loadCallReviews(workspace === ALL ? null : workspace))
  // The filter keeps the full list of workspaces from the first read (a filtered read lists them all too).
  const workspaces = query.data?.workspaces ?? []
  const reviews = query.data?.reviews
  return (
    <Card
      title={t('admin.callReviews.title')}
      actions={
        <Select
          size="sm"
          align="end"
          label={t('admin.callReviews.workspace')}
          value={workspace}
          onChange={setWorkspace}
          options={[
            { value: ALL, label: t('admin.callReviews.allWorkspaces') },
            ...workspaces.map(w => ({
              value: w.id,
              label: t('admin.callReviews.workspaceOption', { name: w.name ?? w.id, count: w.flagged }),
            })),
          ]}
        />
      }
    >
      <Loading
        what={t('admin.callReviews.what')}
        loading={!reviews}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonList rows={4} action />}
      >
        {reviews && reviews.length === 0 ? (
          <p className="adm-empty">{t('admin.callReviews.empty')}</p>
        ) : (
          <ul className="kn-list rv-list">
            {reviews?.map(r => (
              <ReviewRow key={r.call_id} review={r} showWorkspace={workspace === ALL} />
            ))}
          </ul>
        )}
      </Loading>
    </Card>
  )
}

function ReviewRow({ review: r, showWorkspace }: { review: CallReview; showWorkspace: boolean }) {
  const t = useT()
  const when = listTime(parseTs(r.started_at))
  return (
    <li className="kn-row rv-row">
      <div className="kn-main">
        <b>
          <AppLink to={callHref(r)} newTab title={t('admin.callReviews.openCall')}>
            {r.title || t('admin.callReviews.untitled')}
          </AppLink>
        </b>
        <span className="kn-sub">
          {showWorkspace && (
            <>
              <AppLink to={`#admin/workspaces/${encodeURIComponent(r.workspace_id)}`}>
                {r.workspace_name ?? r.workspace_id}
              </AppLink>
              {' · '}
            </>
          )}
          {r.assistant_name ? `${r.assistant_name} · ${when}` : when}
        </span>
        {r.issues.length > 0 && (
          <ul className="evc-issues">
            {r.issues.map(issue => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        {r.unanswered.length > 0 && (
          <span className="kn-sub">{t('admin.callReviews.unanswered', { questions: r.unanswered.join(' · ') })}</span>
        )}
      </div>
      <div className="rv-actions">
        <ScoreBadge score={r.score} model={r.model} />
      </div>
    </li>
  )
}
