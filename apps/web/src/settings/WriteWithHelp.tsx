// "Write with help" (Knowledge › About the business): a short wizard that starts with the website (read by
// knowledge.import, the safe import on the server) so the next step can already say what the business does,
// then asks what the assistant should do, and proposes an About text and use cases. The owner picks what to keep;
// it goes into the draft, never saved without Save.
import { type AssistantGoal, BUSINESS_TEXT_MAX, type KnowledgeImportData } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
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
const GOALS: { id: AssistantGoal; label: string }[] = [
  { id: 'messages', label: 'Take messages and callback requests' },
  { id: 'booking', label: 'Book jobs and appointments' },
  { id: 'prices', label: 'Answer prices and common questions' },
  { id: 'spam', label: 'Screen out sales calls and spam' },
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
  const name = draft.name.trim() || 'the assistant'
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
      toast(`${(e as Error).message} Describe the business instead.`)
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
          Cancel
        </Button>
        <Button key="skip" variant="ghost" disabled={busy} onClick={() => { setUrl(''); setSite(null); setStep('business') }} title="No website: describe the business yourself">
          No website
        </Button>
        <Button busy={busy} key="read" variant="primary" disabled={busy || !url.trim()} onClick={() => void readWebsite()}>
          {busy ? 'Reading…' : 'Next'}
        </Button>
      </>
    ) : step === 'business' ? (
      <>
        <Button key="back-site" variant="ghost" onClick={() => setStep('website')}>
          Back
        </Button>
        <Button
          key="next"
          variant="primary"
          disabled={!canGoOn}
          onClick={() => setStep('goals')}
          title="Next: what should it do"
        >
          Next
        </Button>
      </>
    ) : step === 'goals' ? (
      <>
        <Button key="back" variant="ghost" disabled={busy} onClick={() => setStep('business')}>
          Back
        </Button>
        <Button busy={busy}
          key="write"
          variant="primary"
          disabled={busy}
          onClick={() => void propose()}
          title="Write a proposal to review"
        >
          {busy ? 'Writing…' : 'Write it'}
        </Button>
      </>
    ) : null

  return createPortal(
    <Dialog
      title="Write with help"
      description={
        step === 'website'
          ? 'Step 1 of 4 · Your website'
          : step === 'business'
            ? 'Step 2 of 4 · Your business'
            : step === 'goals'
              ? `Step 3 of 4 · What ${name} should do`
              : 'Step 4 of 4 · Pick what to keep'
      }
      onClose={onClose}
      footer={footer}
    >
      {step === 'website' && (
        <div className="ww-step">
          <Field
            id="ww-url"
            label="Website"
            help={`${brandName()} reads a few of its pages for what you do, your services and prices, and what callers ask.`}
          >
            <Input
              id="ww-url"
              autoFocus
              value={url}
              placeholder="yourbusiness.com"
              onChange={e => { setUrl(e.target.value); setSite(null) }}
              onKeyDown={e => {
                if (e.key === 'Enter' && url.trim() && !busy) {
                  e.preventDefault()
                  void readWebsite()
                }
              }}
            />
          </Field>
          {busy && <p className="help">Reading your website. This takes up to a minute.</p>}
        </div>
      )}
      {step === 'business' && (
        <div className="ww-step">
          <Field
            id="ww-business"
            label="What does the business do?"
            help={site ? 'From your website. Fix anything that is wrong.' : 'Your trade, what you offer and the area you serve.'}
          >
            <TextArea
              id="ww-business"
              value={business}
              onChange={v => setBusiness(v.slice(0, BUSINESS_TEXT_MAX))}
              placeholder="Family-run plumbing and heating in Portland, Beaverton and Lake Oswego. Repairs, water heaters, drain cleaning, 24/7 emergencies."
            />
          </Field>
        </div>
      )}
      {step === 'goals' && (
        <div className="ww-step">
          <fieldset className="ww-goals">
            <legend>{`On calls, ${name} should`}</legend>
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
                <span>{g.label}</span>
              </label>
            ))}
          </fieldset>
          <Field id="ww-note" label="Anything else?" aside="Optional">
            <TextArea
              id="ww-note"
              value={goalsNote}
              onChange={setGoalsNote}
              placeholder="We never give prices on the phone. New customers should leave their address."
            />
          </Field>
          {busy && (
            <p className="help">
              Writing a proposal{url.trim() && !site ? ' and reading your website' : ''}. This takes up to a minute.
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
            toast('Added to the draft. Check it, then save.')
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
            Read {proposal.pages.length} page{proposal.pages.length === 1 ? '' : 's'} of your website.
          </p>
        )}
        {nothing && <p className="help">Nothing new to add: it is all here already.</p>}
        {review.about !== 'same' && (
          <div className="kn-review-block">
            <label className="kn-pick">
              <input
                type="checkbox"
                checked={picks.about}
                onChange={e => setPicks(p => ({ ...p, about: e.target.checked }))}
              />
              <b>{review.about === 'empty' ? 'Use as About the business' : 'Replace your About text with this one'}</b>
            </label>
            <p className="help kn-about-note">
              This text becomes {name}'s instructions on every call. Read it and fix anything wrong before you save.
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
            <b className="kn-review-h">Common calls</b>
            <span className="help">Added to About the business as how to handle them.</span>
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
          Back
        </Button>
        <Button
          variant="primary"
          disabled={!picked}
          onClick={() => onApply(applyImport(draft, proposal, picks))}
          title="Put the picked parts into the draft; nothing is saved until you save"
        >
          Add to draft
        </Button>
      </div>
    </div>
  )
}
