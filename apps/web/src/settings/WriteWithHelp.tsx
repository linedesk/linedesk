// "Write with help" (Knowledge › About the business): a short wizard that asks what the business does
// and what the assistant should do, optionally reads the website (knowledge.import, the safe import on
// the server), and proposes an About text, use cases, services and FAQs. The owner picks what to keep;
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

/** The goals in the order the wizard offers them, in plain words. */
const GOALS: { id: AssistantGoal; label: string }[] = [
  { id: 'messages', label: 'Take messages and callback requests' },
  { id: 'booking', label: 'Book jobs and appointments' },
  { id: 'emergencies', label: 'Handle emergencies' },
  { id: 'prices', label: 'Answer prices and common questions' },
  { id: 'spam', label: 'Screen out sales calls and spam' },
]

type Step = 'business' | 'goals' | 'result'

type Props = {
  assistant: Assistant
  draft: Draft
  replace: (next: Draft) => void
  toast: (text: string) => void
  onClose: () => void
}

export function WriteWithHelp({ assistant, draft, replace, toast, onClose }: Props) {
  const name = draft.name.trim() || 'the assistant'
  const [step, setStep] = useState<Step>('business')
  const [business, setBusiness] = useState('')
  const [url, setUrl] = useState(draft.website)
  const [goals, setGoals] = useState<Set<AssistantGoal>>(() => new Set(['messages', 'emergencies']))
  const [goalsNote, setGoalsNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [proposal, setProposal] = useState<KnowledgeImportData | null>(null)

  async function propose() {
    setBusy(true)
    try {
      const data = await callAction<KnowledgeImportData>('knowledge.import', {
        assistantId: assistant.id,
        ...(business.trim() ? { business: business.trim() } : {}),
        ...(url.trim() ? { url: url.trim() } : {}),
        goals: [...goals],
        ...(goalsNote.trim() ? { goalsNote: goalsNote.trim() } : {}),
      })
      setProposal(data)
      setStep('result')
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canGoOn = !!(business.trim() || url.trim())
  const footer =
    step === 'business' ? (
      <>
        <Button key="cancel" variant="ghost" onClick={onClose}>
          Cancel
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
        <Button
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
        step === 'business'
          ? `Step 1 of 3 · Your business`
          : step === 'goals'
            ? `Step 2 of 3 · What ${name} should do`
            : 'Step 3 of 3 · Pick what to keep'
      }
      onClose={onClose}
      footer={footer}
    >
      {step === 'business' && (
        <div className="ww-step">
          <Field
            id="ww-business"
            label="What does the business do?"
            help="Your trade, what you offer and the area you serve."
          >
            <TextArea
              id="ww-business"
              value={business}
              onChange={v => setBusiness(v.slice(0, BUSINESS_TEXT_MAX))}
              placeholder="Family-run plumbing and heating in Portland, Beaverton and Lake Oswego. Repairs, water heaters, drain cleaning, 24/7 emergencies."
            />
          </Field>
          <Field
            id="ww-url"
            label="Website"
            aside="Optional"
            help="Linedesk reads a few of its pages for facts and prices."
          >
            <Input id="ww-url" value={url} placeholder="yourbusiness.com" onChange={e => setUrl(e.target.value)} />
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
              Writing a proposal{url.trim() ? ' and reading your website' : ''}. This takes up to a minute.
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
  const toggle = (list: 'useCases' | 'services' | 'faqs', i: number) =>
    setPicks(p => {
      const next = new Set(p[list])
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return { ...p, [list]: next }
    })
  const nothing = review.about === 'same' && !proposal.useCases.length && !review.services.length && !review.faqs.length
  const picked = picks.about || picks.useCases.size + picks.services.size + picks.faqs.size > 0
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
        {review.services.length > 0 && (
          <div className="kn-review-block">
            <b className="kn-review-h">Services and prices</b>
            {review.services.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this review
              <label key={i} className="kn-pick">
                <input type="checkbox" checked={picks.services.has(i)} onChange={() => toggle('services', i)} />
                <span>
                  {p.item.name} · {p.item.price || 'Quote only'}
                  {p.was && <span className="kn-was"> was {p.was.price || 'quote only'}</span>}
                  {p.item.description && <span className="kn-sub">{p.item.description}</span>}
                </span>
                <span className="kn-tag">{p.status === 'new' ? 'New' : 'Changed'}</span>
              </label>
            ))}
          </div>
        )}
        {review.faqs.length > 0 && (
          <div className="kn-review-block">
            <b className="kn-review-h">FAQs</b>
            {review.faqs.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this review
              <label key={i} className="kn-pick">
                <input type="checkbox" checked={picks.faqs.has(i)} onChange={() => toggle('faqs', i)} />
                <span>
                  {p.item.q}
                  <span className="kn-sub">{p.item.a}</span>
                  {p.was && <span className="kn-sub kn-was">Yours: {p.was.a}</span>}
                </span>
                <span className="kn-tag">{p.status === 'new' ? 'New' : 'Changed'}</span>
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
          onClick={() => onApply(applyImport(draft, proposal, review, picks))}
          title="Put the picked parts into the draft; nothing is saved until you save"
        >
          Add to draft
        </Button>
      </div>
    </div>
  )
}
