// "Write with help" (Knowledge › About the business): a short wizard that starts with the website (read by
// knowledge.import, the safe import on the server) so the next step can already say what the business does,
// then asks what the assistant should do, and proposes an About text and use cases. The owner picks what to keep;
// it goes into the draft, never saved without Save.
import { type AssistantGoal, BUSINESS_TEXT_MAX, type KnowledgeImportData } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Dialog, Input } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import type { Draft } from './assistantDraft.ts'
import { Field, TextArea } from './fields.tsx'
import {
  applyImport,
  defaultPicks,
  type ImportPicks,
  type ImportReview,
  reviewImport,
  wordDiff,
} from './knowledgeModel.ts'
import { callAction } from './settings-api.ts'
import { brandName } from '../brand.ts'

/** The goals in the order the wizard offers them, in plain words. */
const GOALS: { id: AssistantGoal; label: MessageKey }[] = [
  { id: 'messages', label: msg('settings.writeHelp.goal.messages') },
  { id: 'booking', label: msg('settings.writeHelp.goal.booking') },
  { id: 'prices', label: msg('settings.writeHelp.goal.prices') },
  { id: 'spam', label: msg('settings.writeHelp.goal.spam') },
]

type Step = 'website' | 'business' | 'goals' | 'result'

type Props = {
  assistant: Assistant
  draft: Draft
  replace: (next: Draft) => void
  toast: (text: string) => void
  onClose: () => void
}

export function WriteWithHelp({ assistant, draft, replace, toast, onClose }: Props) {
  const t = useT()
  const name = draft.name.trim() || t('settings.writeHelp.theAssistant')
  const [step, setStep] = useState<Step>('website')
  const [business, setBusiness] = useState('')
  const [url, setUrl] = useState(draft.website)
  const [goals, setGoals] = useState<Set<AssistantGoal>>(() => new Set(['messages']))
  const [goalsNote, setGoalsNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [proposal, setProposal] = useState<KnowledgeImportData | null>(null)
  /** What the website gave in step 1: its About text fills step 2, its pages join the proposal. */
  const [site, setSite] = useState<KnowledgeImportData | null>(null)

  /** Step 1: read the website, so step 2 already says what the business does. */
  async function readWebsite() {
    if (!url.trim()) return setStep('business')
    setBusy(true)
    try {
      const data = await callAction<KnowledgeImportData>('knowledge.import', { assistantId: assistant.id, url: url.trim() })
      setSite(data)
      if (!business.trim()) setBusiness(data.about.slice(0, BUSINESS_TEXT_MAX))
    } catch (e) {
      toast(t('settings.writeHelp.readFailed', { error: (e as Error).message }))
    } finally {
      setBusy(false)
      setStep('business')
    }
  }

  async function propose() {
    setBusy(true)
    try {
      const data = await callAction<KnowledgeImportData>('knowledge.import', {
        assistantId: assistant.id,
        ...(business.trim() ? { business: business.trim() } : {}),
        // Read once: the website's findings from step 1 are merged below.
        ...(url.trim() && !site ? { url: url.trim() } : {}),
        goals: [...goals],
        ...(goalsNote.trim() ? { goalsNote: goalsNote.trim() } : {}),
      })
      setProposal(site ? withSite(data, site) : data)
      setStep('result')
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canGoOn = !!(business.trim() || url.trim())
  const footer =
    step === 'website' ? (
      <>
        <Button key="cancel" variant="ghost" disabled={busy} onClick={onClose}>
          {t('common.action.cancel')}
        </Button>
        <Button key="skip" variant="ghost" disabled={busy} onClick={() => { setUrl(''); setSite(null); setStep('business') }} title={t('settings.writeHelp.noWebsiteTip')}>
          {t('settings.writeHelp.noWebsite')}
        </Button>
        <Button busy={busy} key="read" variant="primary" disabled={busy || !url.trim()} onClick={() => void readWebsite()}>
          {busy ? t('settings.writeHelp.reading') : t('settings.writeHelp.next')}
        </Button>
      </>
    ) : step === 'business' ? (
      <>
        <Button key="back-site" variant="ghost" onClick={() => setStep('website')}>
          {t('settings.writeHelp.back')}
        </Button>
        <Button
          key="next"
          variant="primary"
          disabled={!canGoOn}
          onClick={() => setStep('goals')}
          title={t('settings.writeHelp.nextTip')}
        >
          {t('settings.writeHelp.next')}
        </Button>
      </>
    ) : step === 'goals' ? (
      <>
        <Button key="back" variant="ghost" disabled={busy} onClick={() => setStep('business')}>
          {t('settings.writeHelp.back')}
        </Button>
        <Button busy={busy}
          key="write"
          variant="primary"
          disabled={busy}
          onClick={() => void propose()}
          title={t('settings.writeHelp.writeTip')}
        >
          {busy ? t('settings.writeHelp.writing') : t('settings.writeHelp.write')}
        </Button>
      </>
    ) : null

  return createPortal(
    <Dialog
      title={t('settings.writeHelp.title')}
      description={
        step === 'website'
          ? t('settings.writeHelp.step.website')
          : step === 'business'
            ? t('settings.writeHelp.step.business')
            : step === 'goals'
              ? t('settings.writeHelp.step.goals', { name })
              : t('settings.writeHelp.step.result')
      }
      onClose={onClose}
      footer={footer}
    >
      {step === 'website' && (
        <div className="ww-step">
          <Field
            id="ww-url"
            label={t('settings.writeHelp.website')}
            tip={t('settings.writeHelp.websiteTip', { brand: brandName() })}
          >
            <Input
              id="ww-url"
              autoFocus
              value={url}
              placeholder={t('settings.writeHelp.websitePlaceholder')}
              onChange={e => { setUrl(e.target.value); setSite(null) }}
              onKeyDown={e => {
                if (e.key === 'Enter' && url.trim() && !busy) {
                  e.preventDefault()
                  void readWebsite()
                }
              }}
            />
          </Field>
          {busy && <p className="help">{t('settings.writeHelp.readingWebsite')}</p>}
        </div>
      )}
      {step === 'business' && (
        <div className="ww-step">
          <Field
            id="ww-business"
            label={t('settings.writeHelp.business')}
            help={site ? t('settings.writeHelp.businessFromSite') : t('settings.writeHelp.businessHelp')}
          >
            <TextArea
              id="ww-business"
              value={business}
              onChange={v => setBusiness(v.slice(0, BUSINESS_TEXT_MAX))}
              placeholder={t('settings.writeHelp.businessPlaceholder')}
            />
          </Field>
        </div>
      )}
      {step === 'goals' && (
        <div className="ww-step">
          <fieldset className="ww-goals">
            <legend>{t('settings.writeHelp.goals', { name })}</legend>
            {GOALS.map(g => (
              <label key={g.id} className="kn-pick">
                <input
                  type="checkbox"
                  checked={goals.has(g.id)}
                  onChange={() =>
                    setGoals(prev => {
                      const next = new Set(prev)
                      if (next.has(g.id)) next.delete(g.id)
                      else next.add(g.id)
                      return next
                    })
                  }
                />
                <span>{t(g.label)}</span>
              </label>
            ))}
          </fieldset>
          <Field id="ww-note" label={t('settings.writeHelp.note')} aside={t('settings.writeHelp.optional')}>
            <TextArea
              id="ww-note"
              value={goalsNote}
              onChange={setGoalsNote}
              placeholder={t('settings.writeHelp.notePlaceholder')}
            />
          </Field>
          {busy && (
            <p className="help">
              {url.trim() && !site ? t('settings.writeHelp.writingAndReading') : t('settings.writeHelp.writingProposal')}
            </p>
          )}
        </div>
      )}
      {step === 'result' && proposal && (
        <Result
          draft={draft}
          proposal={proposal}
          name={name}
          onBack={() => setStep('goals')}
          onApply={next => {
            replace(next)
            toast(t('settings.writeHelp.added'))
            onClose()
          }}
        />
      )}
    </Dialog>,
    document.body,
  )
}

/** The proposal with the pages the website gave in step 1. */
const withSite = (data: KnowledgeImportData, site: KnowledgeImportData): KnowledgeImportData => ({
  ...data,
  pages: site.pages,
  website: site.website,
})

/** The word diff with each part's position, which never changes for one diff (a stable key). */
const diffParts = (before: string, after: string) => wordDiff(before, after).map((part, at) => ({ ...part, at }))

function Result({
  draft,
  proposal,
  name,
  onBack,
  onApply,
}: {
  draft: Draft
  proposal: KnowledgeImportData
  name: string
  onBack: () => void
  onApply: (next: Draft) => void
}) {
  const t = useT()
  const [review] = useState<ImportReview>(() => reviewImport(draft, proposal))
  const [picks, setPicks] = useState<ImportPicks>(() => defaultPicks(review, proposal))
  const toggle = (list: 'useCases', i: number) =>
    setPicks(p => {
      const next = new Set(p[list])
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return { ...p, [list]: next }
    })
  const nothing = review.about === 'same' && !proposal.useCases.length
  const picked = picks.about || picks.useCases.size > 0
  return (
    <div className="ww-result">
      <div className="ww-step ww-scroll">
        {proposal.pages.length > 0 && (
          <p className="help">
            {t('settings.writeHelp.pagesRead', { count: proposal.pages.length })}
          </p>
        )}
        {nothing && <p className="help">{t('settings.writeHelp.nothingNew')}</p>}
        {review.about !== 'same' && (
          <div className="kn-review-block">
            <label className="kn-pick">
              <input
                type="checkbox"
                checked={picks.about}
                onChange={e => setPicks(p => ({ ...p, about: e.target.checked }))}
              />
              <b>{review.about === 'empty' ? t('settings.writeHelp.useAbout') : t('settings.writeHelp.replaceAbout')}</b>
            </label>
            <p className="help kn-about-note">
              {t('settings.writeHelp.aboutNote', { name })}
            </p>
            <p className="kn-about-text">
              {review.about === 'empty'
                ? proposal.about
                : diffParts(draft.instructions, proposal.about).map(part => (
                    <span
                      key={part.at}
                      className={cx(part.kind === 'added' && 'kn-add', part.kind === 'removed' && 'kn-del')}
                    >
                      {part.text}
                    </span>
                  ))}
            </p>
          </div>
        )}
        {proposal.useCases.length > 0 && (
          <div className="kn-review-block">
            <b className="kn-review-h">{t('settings.writeHelp.commonCalls')}</b>
            <span className="help">{t('settings.writeHelp.commonCallsHelp')}</span>
            {proposal.useCases.map((u, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this review
              <label key={i} className="kn-pick">
                <input type="checkbox" checked={picks.useCases.has(i)} onChange={() => toggle('useCases', i)} />
                <span>{u}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="kn-foot">
        <Button variant="ghost" onClick={onBack}>
          {t('settings.writeHelp.back')}
        </Button>
        <Button
          variant="primary"
          disabled={!picked}
          onClick={() => onApply(applyImport(draft, proposal, picks))}
          title={t('settings.writeHelp.addTip')}
        >
          {t('settings.writeHelp.add')}
        </Button>
      </div>
    </div>
  )
}
