// Step 1, "Find your business": one field (name and city, or the website). With business lookup on this server the
// name is searched in Google Places and the owner picks the listing; without it, name and website. Then the listing
// and the website become a profile proposal the owner reviews and edits; nothing is saved before Save and continue.
import {
  type BusinessCandidate,
  type BusinessImportData,
  type BusinessLookupFailure,
  type BusinessSearchData,
  type BusinessTemplateId,
  businessTemplateIds,
  businessTemplates,
} from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import type { WebsiteImport } from '../auth.ts'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import { Field, TextArea, TextInput } from '../settings/fields.tsx'
import { callAction, patchWorkspaceSettings } from '../settings/settings-api.ts'
import { useAssistant, useRun } from '../store.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Button } from '../ui/kit.tsx'
import { SkeletonRows } from '../ui/LoadStates.tsx'
import {
  draftFrom,
  draftProblem,
  draftProblems,
  looksLikeWebsite,
  manualProposal,
  type ProfileDraft,
  type ProviderProblem,
  profileSave,
  providerProblem,
  renameBusiness,
  savedProposal,
  sourcesLine,
  switchTemplate,
  websiteChoice,
} from './business.ts'
import { Foot, useStepKeys } from './Frame.tsx'

type Props = {
  businessName: string
  lookup: boolean
  /** Whether a website may be read (no language model, or today's lookups used up: not offered). */
  websiteImport?: WebsiteImport
  /** An instance admin: told that reading the website needs a language model, with the way to set one up. */
  admin: boolean
  onRenamed: (name: string) => void
  onNext: () => void
}

const HEADING = 'Tell us about your business.'

export function BusinessStep(p: Props) {
  const assistant = useAssistant()
  if (assistant) return <FindBusiness assistant={assistant} {...p} />
  return (
    <>
      <div className="ob-body">
        <h1>{HEADING}</h1>
        <SkeletonRows label="Loading your assistant" rows={2} />
      </div>
      <Foot canContinue={false} hint="Loading your assistant…" />
    </>
  )
}

type Phase =
  | { kind: 'find' }
  | { kind: 'manual' }
  | { kind: 'loading'; what: string }
  | { kind: 'review'; proposal: BusinessImportData; fromGoogle: boolean }

function FindBusiness({
  assistant,
  businessName,
  lookup,
  websiteImport,
  admin,
  onRenamed,
  onNext,
}: Props & { assistant: Assistant }) {
  // Lookup found off (or its key refused) by a search since the page loaded: not offered again here.
  const [lookupLost, setLookupLost] = useState(false)
  const canSearch = lookup && !lookupLost
  // Coming back to this step: the review starts from the profile saved before, so Enter saves it again as it was.
  const profile = assistant.business_profile
  const saved = !!(profile.instructions?.trim() || profile.phone || profile.website || profile.description)
  const savedReview = (): Phase => ({
    kind: 'review',
    proposal: savedProposal(profile, businessName, assistant.greeting),
    fromGoogle: false,
  })
  const [phase, setPhase] = useState<Phase>(() => (saved ? savedReview() : { kind: lookup ? 'find' : 'manual' }))
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<BusinessCandidate[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [name, setName] = useState(businessName)
  const [website, setWebsite] = useState('')
  // One place for what went wrong: our own sentence, or a provider only whoever runs the server can fix.
  const [error, setError] = useState<string | ProviderProblem | null>(null)
  // A website import was refused (a limit, the model gone since the page loaded): not offered again here.
  const [websiteFailed, setWebsiteFailed] = useState(false)
  const site = websiteChoice(websiteImport, admin, websiteFailed)

  async function importBusiness(input: { placeId?: string; name?: string; website?: string }, what: string) {
    const back = phase.kind === 'loading' ? { kind: 'find' as const } : phase
    setError(null)
    setPhase({ kind: 'loading', what })
    try {
      const proposal = await callAction<BusinessImportData>('business.import', { assistantId: assistant.id, ...input })
      const googleLost = proposal.failures.some(isGoogle)
      if (googleLost) setLookupLost(true)
      setPhase({ kind: 'review', proposal, fromGoogle: !!input.placeId && !googleLost })
    } catch (e) {
      setError((e as Error).message)
      if (input.website && !input.placeId) setWebsiteFailed(true)
      setPhase(back)
    }
  }

  async function search() {
    const text = query.trim()
    if (text.length < 2) return setError('Type the business name and city, or its website.')
    if (site === 'field' && looksLikeWebsite(text))
      return importBusiness({ name: businessName, website: text }, `Reading ${text}…`)
    setError(null)
    setSearching(true)
    try {
      const found = await callAction<BusinessSearchData>('business.search', { query: text })
      if (!found.lookup) {
        // Business lookup was turned off since the page loaded, or Google refused its key: name and website instead,
        // with who can fix it.
        setName(text)
        setLookupLost(true)
        setPhase({ kind: 'manual' })
        setError(providerProblem(found.failure ?? { provider: 'business', reason: 'config' }, 'search'))
      } else setResults(found.results)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  function manualContinue() {
    if (!name.trim()) return setError('Give the business a name.')
    if (site === 'field' && website.trim())
      return importBusiness({ name: name.trim(), website: website.trim() }, `Reading ${website.trim()}…`)
    setError(null)
    setPhase({ kind: 'review', proposal: manualProposal(name, assistant.name, website), fromGoogle: false })
  }

  if (phase.kind === 'review')
    return (
      <ReviewProfile
        assistant={assistant}
        businessName={businessName}
        onRenamed={onRenamed}
        proposal={phase.proposal}
        fromGoogle={phase.fromGoogle}
        admin={admin}
        onBack={() => setPhase({ kind: canSearch ? 'find' : 'manual' })}
        onNext={onNext}
      />
    )

  return (
    <FindForm
      phase={phase}
      onEnter={phase.kind === 'find' ? () => void search() : phase.kind === 'manual' ? manualContinue : undefined}
      onBack={saved ? () => setPhase(savedReview()) : undefined}
      saved={saved}
      readsWebsite={site === 'field'}
    >
      {phase.kind === 'loading' && (
        <div className="ob-biz-loading" role="status">
          <span>{phase.what}</span>
          <SkeletonRows label={phase.what} rows={3} />
        </div>
      )}
      {phase.kind === 'find' && (
        <>
          <Field
            id="ob-biz-q"
            label="Business name and city"
            help={site === 'field' ? 'Or paste your website.' : undefined}
          >
            <div className="ob-biz-search">
              <TextInput id="ob-biz-q" value={query} onChange={setQuery} placeholder="Business name, city" />
              <Button
                busy={searching}
                variant="primary"
                icon="search"
                disabled={searching}
                onClick={() => void search()}
                title="Search (Enter)"
              >
                {searching ? 'Searching…' : 'Search'}
              </Button>
            </div>
          </Field>
          {results && results.length === 0 && (
            <p className="ob2-note">No listing found. Try the name as it is on Google, or enter it yourself.</p>
          )}
          {results && results.length > 0 && (
            <ResultList
              results={results}
              onPick={r => void importBusiness({ placeId: r.placeId, name: r.name }, `Getting ${r.name}…`)}
            />
          )}
          <p className="ob-tight">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setError(null)
                setPhase({ kind: 'manual' })
              }}
            >
              Not on Google? Enter it yourself
            </Button>
          </p>
        </>
      )}
      {phase.kind === 'manual' && (
        <>
          <Field id="ob-biz-name" label="Business name">
            <TextInput id="ob-biz-name" value={name} onChange={setName} placeholder="Your business name" />
          </Field>
          {site === 'field' && (
            <Field id="ob-biz-site" label="Website" help="Optional. We read a few pages to fill in your services.">
              <TextInput id="ob-biz-site" value={website} onChange={setWebsite} placeholder="yourbusiness.com" />
            </Field>
          )}
          {site === 'paused' && <p className="ob2-note">Website reading is paused for today.</p>}
          {site === 'needs_model' && (
            <ProblemNote problem={providerProblem({ provider: 'llm', reason: 'config' }, 'search')} admin />
          )}
          <p className="ob2-row ob-tight">
            <Button variant="primary" onClick={manualContinue} title="Next (Enter)">
              {site === 'field' && website.trim() ? 'Read my website' : 'Next'}
            </Button>
            {canSearch && (
              <Button size="sm" variant="ghost" onClick={() => setPhase({ kind: 'find' })}>
                Search Google instead
              </Button>
            )}
          </p>
        </>
      )}
      {typeof error === 'string' && (
        <p className="ob-error" role="alert">
          {error}
        </p>
      )}
      {error && typeof error !== 'string' && <ProblemNote problem={error} admin={admin} alert />}
    </FindForm>
  )
}

/**
 * The listings found, as buttons: Enter, Space or a click picks one (and imports it); the arrow keys only move
 * between them. Google's terms ask for the "Google Maps" attribution where Places results show without a map.
 */
function ResultList({ results, onPick }: { results: BusinessCandidate[]; onPick: (r: BusinessCandidate) => void }) {
  function move(e: KeyboardEvent<HTMLUListElement>) {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    const buttons = [...e.currentTarget.querySelectorAll('button')]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    buttons[at < 0 ? 0 : (at + step + buttons.length) % buttons.length]?.focus()
  }
  return (
    <div className="ob-biz-results">
      <ul aria-label="Pick your business" onKeyDown={move}>
        {results.map(r => (
          <li key={r.placeId}>
            <button type="button" className="ob-biz-result" onClick={() => onPick(r)}>
              <b>{r.name}</b>
              <span>{r.address}</span>
            </button>
          </li>
        ))}
      </ul>
      <GoogleMapsCredit />
    </div>
  )
}

const isGoogle = (f: BusinessLookupFailure) => f.provider === 'business'

/**
 * A provider this step could not use: what happened, then who can fix it. Instance admins get the link to
 * Admin › Providers (a new tab: this step stays as it is, and Admin opens there although onboarding is not
 * finished); members are told to ask whoever runs the server.
 */
function ProblemNote({ problem, admin, alert }: { problem: ProviderProblem; admin: boolean; alert?: boolean }) {
  return (
    <p className="ob2-note" role={alert ? 'alert' : undefined}>
      {problem.text}{' '}
      {admin ? (
        <>
          {problem.adminFix}{' '}
          <a className="k-link" href="#admin/providers" target="_blank" rel="noopener">
            Admin › Providers
          </a>
          .
        </>
      ) : (
        'Ask whoever runs this server.'
      )}
    </p>
  )
}

/** The text attribution Google requires for Places content shown without a Google map. */
function GoogleMapsCredit() {
  return (
    <p className="ob-biz-credit" translate="no">
      Google Maps
    </p>
  )
}

function FindForm({
  phase,
  onEnter,
  onBack,
  saved,
  readsWebsite,
  children,
}: {
  phase: Phase
  onEnter?: () => void
  /** Back to the profile saved before (coming back to this step and looking it up again). */
  onBack?: () => void
  saved: boolean
  readsWebsite: boolean
  children: ReactNode
}) {
  useStepKeys({ onEnter })
  return (
    <>
      <div className="ob-body">
        <h1>{HEADING}</h1>
        <p className="ob-lede">
          {saved
            ? 'Look your business up again. Back keeps what you saved.'
            : phase.kind !== 'manual'
              ? `We fill in what your listing${readsWebsite ? ' and website say' : ' says'}. You check it before anything is saved.`
              : readsWebsite
                ? 'You check everything before it is saved.'
                : 'Name your business, then fill in the rest. You check it before anything is saved.'}
        </p>
        {children}
      </div>
      {/* No Continue here: the search (or Next) leads on, the one primary action; the saved profile is one Back away. */}
      <Foot onBack={phase.kind === 'loading' ? undefined : onBack} canContinue={false} />
    </>
  )
}

const templateOptions = businessTemplateIds.map(id => ({ value: id, label: businessTemplates[id].label }))
/** "Choose…" until the owner picks one, when the lookup did not tell the kind of business. */
const NO_TEMPLATE = ''

function ReviewProfile({
  assistant,
  businessName,
  onRenamed,
  proposal,
  fromGoogle,
  admin,
  onBack,
  onNext,
}: {
  assistant: Assistant
  businessName: string
  onRenamed: (name: string) => void
  proposal: BusinessImportData
  fromGoogle: boolean
  admin: boolean
  onBack: () => void
  onNext: () => void
}) {
  const run = useRun()
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFrom(proposal))
  const problem = draftProblem(draft)
  const problems = draftProblems(draft)
  const set = (change: Partial<ProfileDraft>) => setDraft(d => ({ ...d, ...change }))

  function save() {
    if (problem) return
    const { assistant: changes, hours, timeZone, rename } = profileSave(draft, assistant.business_profile, businessName)
    void run('assistant.update', { assistantId: assistant.id, ...changes })
    // The business name is the workspace's name: renamed with it, shown at once in the menu.
    if (rename) {
      void run('workspace.rename', { name: rename })
      onRenamed(rename)
    }
    // Google's hours become the business hours only because the owner kept them; whether calls use them is the
    // next steps' choice ("Only when we're closed").
    if (hours) {
      void run('businessHours.set', { hours })
      if (timeZone) void run('workspace.updateSettings', { timeZone })
      patchWorkspaceSettings({ businessHours: hours, ...(timeZone ? { timeZone } : {}) })
    }
    onNext()
  }
  useStepKeys({ onEnter: save, onEscape: onBack })

  return (
    <>
      <div className="ob-body">
        <h1>
          {fromGoogle
            ? `Is this ${draft.name.trim() || 'your business'}?`
            : `About ${draft.name.trim() || 'your business'}`}
        </h1>
        <p className="ob-lede">{sourcesLine(proposal.pages, fromGoogle)}</p>
        {proposal.notes.map(note => (
          <p key={note} className="ob2-note">
            {note}
          </p>
        ))}
        {proposal.failures.map(f => (
          <ProblemNote key={f.provider} problem={providerProblem(f, 'listing')} admin={admin} />
        ))}
        <Field id="ob-biz-name" label="Business name" error={problems.name}>
          <TextInput
            id="ob-biz-name"
            value={draft.name}
            onChange={v => setDraft(d => renameBusiness(d, v))}
            invalid={!!problems.name}
          />
        </Field>
        <Field id="ob-biz-kind" label="Kind of business" help="Picks the common calls below.">
          <Select<BusinessTemplateId | typeof NO_TEMPLATE>
            id="ob-biz-kind"
            label="Kind of business"
            value={draft.template ?? NO_TEMPLATE}
            options={templateOptions}
            onChange={t => t && setDraft(d => switchTemplate(d, t))}
          />
        </Field>
        <div className="ob-biz-pair">
          <Field id="ob-biz-addr" label="Address">
            <TextInput id="ob-biz-addr" value={draft.address} onChange={v => set({ address: v })} />
          </Field>
          <Field id="ob-biz-area" label="Area you serve">
            <TextInput
              id="ob-biz-area"
              value={draft.area}
              onChange={v => set({ area: v })}
              placeholder="The towns or neighborhoods you serve"
            />
          </Field>
          <Field id="ob-biz-phone" label="Phone" error={problems.phone}>
            <TextInput
              id="ob-biz-phone"
              value={draft.phone}
              onChange={v => set({ phone: v })}
              invalid={!!problems.phone}
            />
          </Field>
          <Field id="ob-biz-web" label="Website" error={problems.website}>
            <TextInput
              id="ob-biz-web"
              value={draft.website}
              onChange={v => set({ website: v })}
              invalid={!!problems.website}
              placeholder="yourbusiness.com"
            />
          </Field>
        </div>
        {!!draft.hours?.length && (
          <div className="ob-biz-hours">
            <Checkbox checked={draft.useHours} onChange={v => set({ useHours: v })}>
              Use these hours from Google
            </Checkbox>
            <ul>
              {draft.hoursText.map(h => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            <span className="ob2-note">They matter only if {assistant.name} picks up when you're closed.</span>
          </div>
        )}
        <Field id="ob-biz-services" label="Services" help="One per line, with prices if you want callers to hear them.">
          <TextArea id="ob-biz-services" value={draft.services} onChange={v => set({ services: v })} />
        </Field>
        <Field id="ob-biz-about" label="About" help={`What ${assistant.name} tells callers about you.`}>
          <TextArea
            id="ob-biz-about"
            value={draft.about}
            onChange={v => set({ about: v })}
            placeholder="What you do, for whom, and what callers often ask."
          />
        </Field>
        <Field id="ob-biz-calls" label="Common calls" help="One per line: when a caller …, what to do.">
          <TextArea id="ob-biz-calls" value={draft.useCases} onChange={v => set({ useCases: v })} tall />
        </Field>
        {/* The greeting with the business's name is saved too; the owner hears and edits it in the next step. */}
        {fromGoogle && <GoogleMapsCredit />}
      </div>
      <Foot onBack={onBack} onContinue={save} canContinue={!problem} label="Save and continue" />
    </>
  )
}
