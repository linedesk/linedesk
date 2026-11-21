// The support mail analysis on Integrations › Support email (LIN-643, step 3 of LIN-615): read with
// mail.getAnalysis (not a synced table), started with mail.analyze, each topic reviewed with mail.reviewTopic. The
// answer of every write replaces the cached one at once (setQueryData), so the page never waits for a reload.
import type { MailAnalysis, MailAnalysisError, MailTopic } from '@linedesk/actions'
import { mailTopicLine } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useEffect, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { refreshGoLiveChecklist } from '../inbox/GoLiveChecklist.tsx'
import { readAction, useWriteAction } from '../settings/settings-api.ts'

export const ANALYSIS_KEY = 'mail.analysis'
const loadAnalysis = () => readAction<{ analysis: MailAnalysis | null }>('mail.getAnalysis').then(d => d.analysis)

/** While an analysis is queued or running, it is read again this often. */
const POLL_MS = 4_000

export const isPending = (a: MailAnalysis | null | undefined) => a?.status === 'queued' || a?.status === 'running'

/** What the owner edits before accepting: the question as a caller asks it, the answer, the facts to ask for. */
export type TopicDraft = { question: string; answer: string; facts: string[] }

export const draftOf = (topic: MailTopic): TopicDraft => ({
  question: (topic.example || topic.title).trim(),
  answer: topic.answer.trim(),
  facts: topic.factsNeeded,
})

export const canAccept = (d: TopicDraft) => d.question.trim().length > 0 && d.answer.trim().length > 0

/** The exact line the assistant reads once the topic is accepted. */
export const previewLine = (d: TopicDraft) => mailTopicLine(d.question.trim(), d.answer.trim(), d.facts)

export type TopicState = 'open' | 'accepted' | 'dropped'
export const stateOf = (topic: MailTopic): TopicState =>
  topic.review?.decision === 'accepted' ? 'accepted' : topic.review?.decision === 'dropped' ? 'dropped' : 'open'

export function counts(topics: MailTopic[]) {
  const c = { open: 0, accepted: 0, dropped: 0 }
  for (const t of topics) c[stateOf(t)]++
  return c
}

const ERROR_KEY: Record<MailAnalysisError, MessageKey> = {
  no_model: msg('settings.integrations.mailReview.error.noModel'),
  no_mailbox: msg('settings.integrations.mailReview.error.noMailbox'),
  account_refused: msg('settings.integrations.mailReview.error.accountRefused'),
  unavailable: msg('settings.integrations.mailReview.error.unavailable'),
  no_conversations: msg('settings.integrations.mailReview.error.noConversations'),
  failed: msg('settings.integrations.mailReview.error.failed'),
}
export const analysisErrorKey = (code: MailAnalysisError | null) => ERROR_KEY[code ?? 'failed'] ?? ERROR_KEY.failed

/** The assistants an accepted topic can go to, oldest first (the first is the default). */
export const assistantChoices = (rows: readonly Assistant[]) =>
  [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))

export type MailReview = {
  analysis: MailAnalysis | null | undefined
  error: string | null
  reload: () => Promise<void>
  starting: boolean
  start: (months: 6 | 12) => Promise<void>
  /** The topic index a review is on its way for. */
  busy: number | null
  accept: (index: number, draft: TopicDraft, assistantId: string) => Promise<boolean>
  drop: (index: number) => Promise<boolean>
  reopen: (index: number) => Promise<boolean>
}

export function useMailReview(toast: (text: string) => void): MailReview {
  const query = useQuery(ANALYSIS_KEY, loadAnalysis)
  const write = useWriteAction()
  const [starting, setStarting] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const pending = isPending(query.data)
  const { reload } = query

  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [pending, reload])

  // A finished analysis (and every review below) can tick the go-live checklist's "Review the common questions".
  const finished = query.data?.status === 'done'
  useEffect(() => {
    if (finished) void refreshGoLiveChecklist()
  }, [finished])

  const put = (analysis: MailAnalysis) => setQueryData<MailAnalysis | null>(ANALYSIS_KEY, analysis)

  async function start(months: 6 | 12) {
    setStarting(true)
    try {
      put((await write<{ analysis: MailAnalysis }>('mail.analyze', { months })).analysis)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const review = async (index: number, input: object) => {
    const analysis = query.data
    if (!analysis) return false
    setBusy(index)
    try {
      put(
        (await write<{ analysis: MailAnalysis }>('mail.reviewTopic', { analysisId: analysis.id, index, ...input }))
          .analysis,
      )
      void refreshGoLiveChecklist()
      return true
    } catch (e) {
      toast((e as Error).message)
      return false
    } finally {
      setBusy(null)
    }
  }

  return {
    analysis: query.data,
    error: query.error,
    reload,
    starting,
    start,
    busy,
    accept: (index, d, assistantId) =>
      review(index, {
        decision: 'accept',
        assistantId,
        question: d.question.trim(),
        answer: d.answer.trim(),
        factsNeeded: d.facts.map(f => f.trim()).filter(Boolean),
      }),
    drop: index => review(index, { decision: 'drop' }),
    reopen: index => review(index, { decision: 'reopen' }),
  }
}
