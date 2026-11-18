// Step 1, "Find your business": one field (name and city, or the website). With business lookup on this server the
// name is searched in Google Places and the owner picks the listing; without it, name and website. Then the listing
// and the website become a profile proposal the owner reviews and edits; nothing is saved before Continue.
import {
  type BusinessCandidate,
  type BusinessImportData,
  type BusinessLookupFailure,
  type BusinessSearchData,
  type BusinessTemplateId,
  businessTemplateIds,
  phoneCountryName,
} from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import type { WebsiteImport } from '../auth.ts'
import { brandName } from '../brand.ts'
import { i18n } from '../i18n/index.tsx'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'
import { appLink, LinkButton } from '../ui/AppLink.tsx'
import { Field, TextArea, TextInput } from '../settings/fields.tsx'
import { callAction, patchWorkspaceSettings, useWorkspaceSettings } from '../settings/settings-api.ts'
import { CountrySelect } from '../settings/CountrySelect.tsx'
import { TimeZoneSelect } from '../settings/BusinessHours.tsx'
import { timeZoneLabel } from '../settings/timeZones.ts'
import { useAssistantOf, useRun } from '../store.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Button, Icon, Note } from '../ui/kit.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { flagOf } from '../ui/phoneInputModel.ts'
import { useDefaultPhoneCountry } from '../phoneCountry.ts'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
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
  shownTimeZone,
  timeZoneToSave,
  zoneForCountry,
  savedProposal,
  sourcesLine,
  switchTemplate,
  websiteChoice,
} from './business.ts'
import { Foot, useStepKeys } from './Frame.tsx'
import { useClientWord } from './clientWords.tsx'

type Props = {
  businessName: string
  lookup: boolean
  /** Whether a website may be read (no language model, or today's lookups used up: not offered). */
  websiteImport?: WebsiteImport
  /** An instance admin: told that reading the website needs a language model, with the way to set one up. */
  admin: boolean
  onRenamed: (name: string) => void
  onNext: () => void
  /** The assistant whose business profile this is (step by step from its settings); else the default one. */
  assistantId?: string
}

export function BusinessStep(p: Props) {
  const t = useT()
  const word = useClientWord()
  const assistant = useAssistantOf(p.assistantId)
  if (assistant) return <FindBusiness assistant={assistant} {...p} />
  return (
    <>
      <div className="ob-body">
        <h1>{t(word('onboarding.business.heading'))}</h1>
        <Loading what={t('onboarding.assistant.loadingWhat')} loading skeleton={<SkeletonFields fields={2} />} />
      </div>
      <Foot canContinue={false} />
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
  const t = useT()
  const word = useClientWord()
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
  // A business named already (a partner's client draft, a workspace made with its name) and no lookup to search with:
  // nothing more to ask before the review, which starts from that name.
  const namedReview = (): Phase => ({
    kind: 'review',
    proposal: manualProposal(businessName, assistant.name),
    fromGoogle: false,
  })
  const [phase, setPhase] = useState<Phase>(() =>
    saved ? savedReview() : lookup ? { kind: 'find' } : businessName.trim() ? namedReview() : { kind: 'manual' },
  )
  // The search starts from the name the business has.
  const [query, setQuery] = useState(businessName)
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
    if (text.length < 2) return setError(t('onboarding.business.searchTooShort'))
    if (site === 'field' && looksLikeWebsite(text))
      return importBusiness({ name: businessName, website: text }, t('onboarding.business.reading', { site: text }))
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
    if (!name.trim()) return setError(t('onboarding.business.nameRequired'))
    if (site === 'field' && website.trim())
      return importBusiness(
        { name: name.trim(), website: website.trim() },
        t('onboarding.business.reading', { site: website.trim() }),
      )
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
      // Naming the business by hand: Continue (or Read my website) is the footer's primary, as on every other step.
      primary={
        phase.kind === 'manual'
          ? {
              onClick: manualContinue,
              label:
                site === 'field' && website.trim()
                  ? t('onboarding.business.manual.readWebsite')
                  : t('onboarding.action.continue'),
            }
          : undefined
      }
      saved={saved}
      readsWebsite={site === 'field'}
    >
      {phase.kind === 'loading' && (
        <div className="ob-biz-loading" role="status">
          <span>{phase.what}</span>
          <Loading what={phase.what} loading skeleton={<SkeletonFields fields={3} />} />
        </div>
      )}
      {phase.kind === 'find' && (
        <>
          <Field
            id="ob-biz-q"
            label={t('onboarding.business.find.label')}
            help={site === 'field' ? t(word('onboarding.business.find.help')) : undefined}
          >
            <div className="ob-biz-search">
              <TextInput
                id="ob-biz-q"
                value={query}
                onChange={setQuery}
                placeholder={t('onboarding.business.find.placeholder')}
              />
              <Button
                busy={searching}
                variant="primary"
                icon="search"
                disabled={searching}
                onClick={() => void search()}
                title={t('onboarding.business.find.searchTip', { key: 'Enter' })}
              >
                {t('common.search.button')}
              </Button>
            </div>
          </Field>
          {results && results.length === 0 && <p className="ob2-note">{t('onboarding.business.find.none')}</p>}
          {results && results.length > 0 && (
            <ResultList
              results={results}
              onPick={r =>
                void importBusiness(
                  { placeId: r.placeId, name: r.name },
                  t('onboarding.business.getting', { name: r.name }),
                )
              }
            />
          )}
          <p className="ob-biz-manual">
            <T
              k="onboarding.business.find.manualOr"
              values={{
                link: chunks => (
                  <LinkButton
                    onClick={() => {
                      setError(null)
                      setPhase({ kind: 'manual' })
                    }}
                  >
                    {chunks}
                  </LinkButton>
                ),
              }}
            />
          </p>
        </>
      )}
      {phase.kind === 'manual' && (
        <>
          <Field id="ob-biz-name" label={t('onboarding.business.field.name')}>
            <TextInput
              id="ob-biz-name"
              value={name}
              onChange={setName}
              placeholder={t(word('onboarding.business.manual.namePlaceholder'))}
            />
          </Field>
          {site === 'field' && (
            <Field
              id="ob-biz-site"
              label={t('onboarding.business.field.website')}
              aside={t('onboarding.business.field.optional')}
              tip={t('onboarding.business.manual.websiteTip')}
            >
              <TextInput
                id="ob-biz-site"
                value={website}
                onChange={setWebsite}
                placeholder={t('onboarding.business.field.websitePlaceholder')}
              />
            </Field>
          )}
          {site === 'paused' && <p className="ob2-note">{t('onboarding.business.manual.paused')}</p>}
          {site === 'needs_model' && (
            <ProblemNote problem={providerProblem({ provider: 'llm', reason: 'config' }, 'search')} admin />
          )}
          {canSearch && (
            <p className="ob2-row ob-tight">
              <Button size="sm" variant="ghost" onClick={() => setPhase({ kind: 'find' })}>
                {t('onboarding.business.manual.searchGoogle')}
              </Button>
            </p>
          )}
        </>
      )}
      {typeof error === 'string' && <Note tone="danger">{error}</Note>}
      {error && typeof error !== 'string' && <ProblemNote problem={error} admin={admin} alert />}
    </FindForm>
  )
}

/**
 * What the Business step saves of the country: what the owner picked (Change), else the listing's (Google says where
 * the business is). A country only worked out (the sign-up location, the time zone) and left as shown is not saved as
 * set (it stays Automatic, so a number connected later still decides it).
 */
export function localeToSave(
  pickedCountry: string | null,
  savedCountry: string | null,
  listingCountry: string | null = null,
): { country?: string } {
  const country = pickedCountry ?? listingCountry
  return country !== null && country !== savedCountry ? { country } : {}
}

/**
 * Whether the business is in a country this workspace is not served in yet (a workspace on a Linedesk Cloud bill:
 * only the sign-up countries). Null `served`: every country is.
 */
export const countryNotServed = (country: string, served: readonly string[] | null | undefined) =>
  !!served && !served.includes(country)

/**
 * The listings found, as buttons: Enter, Space or a click picks one (and imports it); the arrow keys only move
 * between them. Google's terms ask for the "Google Maps" attribution where Places results show without a map.
 */
function ResultList({ results, onPick }: { results: BusinessCandidate[]; onPick: (r: BusinessCandidate) => void }) {
  const t = useT()
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
      <ul aria-label={t('onboarding.business.find.results')} onKeyDown={move}>
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
 * Server admin › Providers (a new tab: this step stays as it is, and Server admin opens there although onboarding is
 * not finished); members are told to ask whoever runs the server.
 */
function ProblemNote({ problem, admin, alert }: { problem: ProviderProblem; admin: boolean; alert?: boolean }) {
  const t = useT()
  return (
    <Note tone="warning" role={alert ? 'alert' : undefined}>
      {problem.text}{' '}
      {admin ? (
        <T
          k={problem.adminFix}
          values={{
            link: appLink(`#admin/providers/${problem.group}`, { newTab: true }),
          }}
        />
      ) : (
        t('onboarding.business.problem.askAdmin')
      )}
    </Note>
  )
}

/** Google's own words, never translated (its attribution rules). */
const GOOGLE_MAPS = 'Google Maps'

/** The text attribution Google requires for Places content shown without a Google map. */
function GoogleMapsCredit() {
  return (
    <p className="ob-biz-credit" translate="no">
      {GOOGLE_MAPS}
    </p>
  )
}

function FindForm({
  phase,
  onEnter,
  onBack,
  primary,
  saved,
  readsWebsite,
  children,
}: {
  phase: Phase
  onEnter?: () => void
  /** Back to the profile saved before (coming back to this step and looking it up again). */
  onBack?: () => void
  /** The footer's primary button (naming the business by hand); none while searching (the search leads on). */
  primary?: { onClick: () => void; label: string }
  saved: boolean
  readsWebsite: boolean
  children: ReactNode
}) {
  const t = useT()
  const word = useClientWord()
  useStepKeys({ onEnter })
  return (
    <>
      <div className="ob-body">
        <h1>{t(word('onboarding.business.heading'))}</h1>
        <p className="ob-lede">
          {saved
            ? t(word('onboarding.business.lede.saved'))
            : phase.kind !== 'manual'
              ? t(
                  word(
                    readsWebsite ? 'onboarding.business.lede.listingAndWebsite' : 'onboarding.business.lede.listing',
                  ),
                )
              : readsWebsite
                ? t('onboarding.business.lede.manualWebsite')
                : t(word('onboarding.business.lede.manual'))}
        </p>
        {children}
      </div>
      {/* While searching, the search leads on (the one primary action); the saved profile is one Back away. */}
      <Foot
        onBack={phase.kind === 'loading' ? undefined : onBack}
        onContinue={primary?.onClick}
        canContinue={!!primary}
        label={primary?.label}
      />
    </>
  )
}

const templateLabelKeys: Record<BusinessTemplateId, MessageKey> = {
  plumbing_hvac: msg('onboarding.business.template.plumbingHvac'),
  dental_medical: msg('onboarding.business.template.dentalMedical'),
  salon_spa: msg('onboarding.business.template.salonSpa'),
  law_office: msg('onboarding.business.template.lawOffice'),
  home_services: msg('onboarding.business.template.homeServices'),
  other: msg('onboarding.business.template.other'),
}
/** In the active language: built when the step shows, never at import (that would freeze English). */
const templateOptions = () => businessTemplateIds.map(id => ({ value: id, label: i18n().t(templateLabelKeys[id]) }))
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
  const t = useT()
  const word = useClientWord()
  const run = useRun()
  const phoneCountry = useDefaultPhoneCountry()
  const settings = useWorkspaceSettings().data
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFrom(proposal))
  // Where the business is: what the workspace has, set when it was made (New workspace) or worked out by the API
  // (workspace-locale.ts, the same order as Workspace settings › General), until the owner picks.
  const [pickedCountry, setPickedCountry] = useState<string | null>(null)
  const [changingCountry, setChangingCountry] = useState(false)
  // The listing's country (Google), else the workspace's, until the owner picks.
  const listingCountry = proposal.country ?? null
  const country = pickedCountry ?? listingCountry ?? phoneCountry
  // A workspace on a Linedesk Cloud bill is served only in the sign-up countries: a business elsewhere stops here.
  const served = settings?.servedCountries ?? null
  const notServed = countryNotServed(country, served)
  // The time zone: the workspace's (set when it was made, from its country), the listing's when Google has one, until
  // the owner picks one (Change) or picks another country (the zone then follows it, zoneForCountry).
  const savedZone = settings?.timeZone ?? null
  const [pickedZone, setPickedZone] = useState<string | null>(null)
  const [changingZone, setChangingZone] = useState(false)
  const zone = shownTimeZone(pickedZone, draft, savedZone)
  function pickCountry(next: string) {
    setPickedCountry(next)
    const followed = zoneForCountry(next, zone)
    if (followed && followed !== zone) setPickedZone(followed)
  }
  const problem = draftProblem(draft)
  const problems = draftProblems(draft)
  const set = (change: Partial<ProfileDraft>) => setDraft(d => ({ ...d, ...change }))

  function save() {
    if (problem || notServed) return
    const { assistant: changes, hours, rename } = profileSave(draft, assistant.business_profile, businessName)
    void run('assistant.update', { assistantId: assistant.id, ...changes })
    // Saved as set only what the owner picked: a country left as shown stays Automatic, so a number connected later
    // (or the business phone) still decides it.
    // The time zone shown is saved (as set by hand) when it is not what the workspace has or gets with the country.
    const country = localeToSave(pickedCountry, settings?.country ?? null, listingCountry)
    const locale = { ...country, ...timeZoneToSave(zone, savedZone, country.country, settings?.timeZoneFollowsCountry) }
    if (Object.keys(locale).length) {
      void run('workspace.updateSettings', locale)
      patchWorkspaceSettings({
        ...locale,
        ...(locale.country ? { resolvedCountry: locale.country, countrySource: 'explicit' as const } : {}),
      })
    }
    // The business name is the workspace's name: renamed with it, shown at once in the menu.
    if (rename) {
      void run('workspace.rename', { name: rename })
      onRenamed(rename)
    }
    // Google's hours become the business hours only because the owner kept them; whether calls use them is the
    // next steps' choice ("Only when we're closed").
    if (hours) {
      void run('businessHours.set', { hours })
      patchWorkspaceSettings({ businessHours: hours })
    }
    onNext()
  }
  useStepKeys({ onEnter: save, onEscape: onBack })

  const heading = fromGoogle
    ? draft.name.trim()
      ? t('onboarding.business.review.isThis', { name: draft.name.trim() })
      : t(word('onboarding.business.review.isThisYours'))
    : draft.name.trim()
      ? t('onboarding.business.review.about', { name: draft.name.trim() })
      : t(word('onboarding.business.review.aboutYours'))

  // A business in a country not served yet: the step stops here. Only the calm "not yet" note and the country (to pick
  // the right one when the listing's is wrong); Back looks the business up again. Nothing else to fill in.
  if (notServed)
    return (
      <>
        <div className="ob-body">
          <h1>{heading}</h1>
          <Note tone="info" title={t('auth.signup.notYetTitle')} role="status">
            {t('onboarding.business.notServed', { brand: brandName(), country: phoneCountryName(country, i18n()) })}
          </Note>
          <Field
            id="ob-biz-country"
            label={t('settings.general.country.label')}
            tip={t('settings.general.country.tip')}
          >
            <CountrySelect id="ob-biz-country" value="" onChange={pickCountry} served={served} />
          </Field>
        </div>
        <Foot onBack={onBack} canContinue={false} />
      </>
    )

  return (
    <>
      <div className="ob-body">
        <h1>{heading}</h1>
        <p className="ob-lede">{sourcesLine(proposal.pages, fromGoogle)}</p>
        {proposal.notes.map(note => (
          <p key={note} className="ob2-note">
            {note}
          </p>
        ))}
        {proposal.failures.map(f => (
          <ProblemNote key={f.provider} problem={providerProblem(f, 'listing')} admin={admin} />
        ))}
        <Field id="ob-biz-name" label={t('onboarding.business.field.name')} error={problems.name}>
          <TextInput
            id="ob-biz-name"
            value={draft.name}
            onChange={v => setDraft(d => renameBusiness(d, v))}
            invalid={!!problems.name}
          />
        </Field>
        <Field
          id="ob-biz-kind"
          label={t('onboarding.business.field.kind')}
          tip={t('onboarding.business.field.kindTip')}
        >
          <Select<BusinessTemplateId | typeof NO_TEMPLATE>
            id="ob-biz-kind"
            label={t('onboarding.business.field.kind')}
            value={draft.template ?? NO_TEMPLATE}
            options={templateOptions()}
            onChange={kind => kind && setDraft(d => switchTemplate(d, kind))}
          />
        </Field>
        <div className="ob-biz-pair">
          <Field id="ob-biz-addr" label={t('onboarding.business.field.address')}>
            <TextInput id="ob-biz-addr" value={draft.address} onChange={v => set({ address: v })} />
          </Field>
          <Field id="ob-biz-area" label={t('onboarding.business.field.area')}>
            <TextInput
              id="ob-biz-area"
              value={draft.area}
              onChange={v => set({ area: v })}
              placeholder={t('onboarding.business.field.areaPlaceholder')}
            />
          </Field>
          <Field id="ob-biz-phone" label={t('onboarding.business.field.phone')} error={problems.phone}>
            <PhoneInput
              id="ob-biz-phone"
              value={draft.phone}
              defaultCountry={phoneCountry}
              autoComplete="off"
              onChange={v => set({ phone: v })}
              invalid={!!problems.phone}
            />
          </Field>
          <Field id="ob-biz-web" label={t('onboarding.business.field.website')} error={problems.website}>
            <TextInput
              id="ob-biz-web"
              value={draft.website}
              onChange={v => set({ website: v })}
              invalid={!!problems.website}
              placeholder={t('onboarding.business.field.websitePlaceholder')}
            />
          </Field>
          <Field
            id="ob-biz-country"
            label={t('settings.general.country.label')}
            tip={t('settings.general.country.tip')}
          >
            {changingCountry ? (
              <CountrySelect id="ob-biz-country" value={country} onChange={pickCountry} served={served} />
            ) : (
              <span className="ob-biz-country">
                <span id="ob-biz-country">
                  {flagOf(country)} {phoneCountryName(country, i18n())}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  title={t('onboarding.business.field.countryChangeTip')}
                  onClick={() => setChangingCountry(true)}
                >
                  {t('onboarding.business.field.countryChange')}
                </Button>
              </span>
            )}
          </Field>
          {zone && (
            <Field
              id="ob-biz-zone"
              label={t('settings.general.timeZone.label')}
              tip={t('settings.general.timeZone.tip')}
            >
              {changingZone ? (
                <TimeZoneSelect id="ob-biz-zone" value={zone} onChange={setPickedZone} />
              ) : (
                <span className="ob-biz-country">
                  <span id="ob-biz-zone">{timeZoneLabel(zone)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    title={t('onboarding.business.field.timeZoneChangeTip')}
                    onClick={() => setChangingZone(true)}
                  >
                    {t('onboarding.business.field.timeZoneChange')}
                  </Button>
                </span>
              )}
            </Field>
          )}
        </div>
        {!!draft.hours?.length && (
          <div className="ob-biz-hours">
            <Checkbox checked={draft.useHours} onChange={v => set({ useHours: v })}>
              {t('onboarding.business.hours.use')}
            </Checkbox>
            <ul>
              {draft.hoursText.map(h => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            <span className="ob2-note">{t('onboarding.business.hours.note', { assistant: assistant.name })}</span>
          </div>
        )}
        {/* What callers hear about the business: filled in from the listing or the kind of business, so it folds away
            under the basics; the owner opens it to check or change it. */}
        <details className="ob-more">
          <summary title={t('onboarding.business.more.tip')}>
            <Icon name="down" size={14} className="ob-more-chevron" />
            <b>{t('onboarding.business.more.title')}</b>
            <span>{t('onboarding.business.more.what')}</span>
          </summary>
          <div className="ob-more-body">
            <Field
              id="ob-biz-services"
              label={t('onboarding.business.field.services')}
              help={t('onboarding.business.field.servicesHelp')}
            >
              <TextArea id="ob-biz-services" value={draft.services} onChange={v => set({ services: v })} />
            </Field>
            <Field
              id="ob-biz-about"
              label={t('onboarding.business.field.about')}
              help={t('onboarding.business.field.aboutHelp', { assistant: assistant.name })}
            >
              <TextArea
                id="ob-biz-about"
                value={draft.about}
                onChange={v => set({ about: v })}
                placeholder={t('onboarding.business.field.aboutPlaceholder')}
              />
            </Field>
            <Field
              id="ob-biz-calls"
              label={t('onboarding.business.field.calls')}
              help={t('onboarding.business.field.callsHelp')}
            >
              <TextArea id="ob-biz-calls" value={draft.useCases} onChange={v => set({ useCases: v })} tall />
            </Field>
          </div>
        </details>
        {/* The greeting with the business's name is saved too; the owner hears and edits it in the next step. */}
        {fromGoogle && <GoogleMapsCredit />}
      </div>
      <Foot onBack={onBack} onContinue={save} canContinue={!problem} />
    </>
  )
}
