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
  phoneCountryName,
} from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import type { WebsiteImport } from '../auth.ts'
import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react'
import { T, useLocale, useT } from '@linedesk/i18n/react'
import { appLink, LinkButton } from '../ui/AppLink.tsx'
import { Field, TextArea, TextInput } from '../settings/fields.tsx'
import { callAction, patchWorkspaceSettings, useWorkspaceSettings } from '../settings/settings-api.ts'
import { CountrySelect } from '../settings/CountrySelect.tsx'
import { AUTOMATIC, languageOptions } from '../settings/workspaceLocaleModel.ts'
import { SearchSelect } from '../ui/SearchSelect.tsx'
import { useAssistant, useRun } from '../store.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { flagOf } from '../ui/phoneInputModel.ts'
import { sectionHash } from '../ui/SettingsLayout.tsx'
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

export function BusinessStep(p: Props) {
  const t = useT()
  const assistant = useAssistant()
  if (assistant) return <FindBusiness assistant={assistant} {...p} />
  return (
    <>
      <div className="ob-body">
        <h1>{t('onboarding.business.heading')}</h1>
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
            help={site === 'field' ? t('onboarding.business.find.help') : undefined}
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
                {searching ? t('onboarding.business.find.searching') : t('common.search.button')}
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
              placeholder={t('onboarding.business.manual.namePlaceholder')}
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
          <p className="ob2-row ob-tight">
            <Button
              variant="primary"
              onClick={manualContinue}
              title={t('onboarding.business.manual.nextTip', { key: 'Enter' })}
            >
              {site === 'field' && website.trim()
                ? t('onboarding.business.manual.readWebsite')
                : t('onboarding.business.manual.next')}
            </Button>
            {canSearch && (
              <Button size="sm" variant="ghost" onClick={() => setPhase({ kind: 'find' })}>
                {t('onboarding.business.manual.searchGoogle')}
              </Button>
            )}
          </p>
        </>
      )}
      {typeof error === 'string' && <Note tone="danger">{error}</Note>}
      {error && typeof error !== 'string' && <ProblemNote problem={error} admin={admin} alert />}
    </FindForm>
  )
}

/**
 * What the Business step saves of country and language: only what the owner picked (Change, or the language select).
 * A country left as shown is not saved as set (it stays Automatic, so a number connected later still decides it).
 */
export function localeToSave(
  pickedCountry: string | null,
  pickedLanguage: string | null,
  savedCountry: string | null,
): { country?: string; language?: string | null } {
  return {
    ...(pickedCountry !== null && pickedCountry !== savedCountry ? { country: pickedCountry } : {}),
    ...(pickedLanguage !== null ? { language: pickedLanguage === AUTOMATIC ? null : pickedLanguage } : {}),
  }
}

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
  const t = useT()
  useStepKeys({ onEnter })
  return (
    <>
      <div className="ob-body">
        <h1>{t('onboarding.business.heading')}</h1>
        <p className="ob-lede">
          {saved
            ? t('onboarding.business.lede.saved')
            : phase.kind !== 'manual'
              ? t(readsWebsite ? 'onboarding.business.lede.listingAndWebsite' : 'onboarding.business.lede.listing')
              : readsWebsite
                ? t('onboarding.business.lede.manualWebsite')
                : t('onboarding.business.lede.manual')}
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
  const t = useT()
  const run = useRun()
  const phoneCountry = useDefaultPhoneCountry()
  const settings = useWorkspaceSettings().data
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFrom(proposal))
  // Where the business is and its language: what the workspace has, set when it was made (New workspace) or worked out
  // by the API (workspace-locale.ts, the same order as Workspace settings › General), until the owner picks.
  const [pickedCountry, setPickedCountry] = useState<string | null>(null)
  const [changingCountry, setChangingCountry] = useState(false)
  const [pickedLanguage, setPickedLanguage] = useState<string | null>(null)
  const country = pickedCountry ?? phoneCountry
  const language = pickedLanguage ?? settings?.language ?? AUTOMATIC
  const ui = useLocale()
  const languageChoices = useMemo(() => languageOptions(country, ui), [country, ui])
  const problem = draftProblem(draft)
  const problems = draftProblems(draft)
  const set = (change: Partial<ProfileDraft>) => setDraft(d => ({ ...d, ...change }))

  function save() {
    if (problem) return
    const { assistant: changes, hours, timeZone, rename } = profileSave(draft, assistant.business_profile, businessName)
    void run('assistant.update', { assistantId: assistant.id, ...changes })
    // Saved as set only what the owner picked: a country left as shown stays Automatic, so a number connected later
    // (or the business phone) still decides it. The language likewise (else it follows the country).
    const locale = localeToSave(pickedCountry, pickedLanguage, settings?.country ?? null)
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
            ? draft.name.trim()
              ? t('onboarding.business.review.isThis', { name: draft.name.trim() })
              : t('onboarding.business.review.isThisYours')
            : draft.name.trim()
              ? t('onboarding.business.review.about', { name: draft.name.trim() })
              : t('onboarding.business.review.aboutYours')}
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
            options={templateOptions}
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
              <CountrySelect id="ob-biz-country" value={country} onChange={setPickedCountry} />
            ) : (
              <span className="ob-biz-country">
                <span id="ob-biz-country">
                  {flagOf(country)} {phoneCountryName(country)}
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
          <Field
            id="ob-biz-language"
            label={t('settings.general.language.label')}
            // The same texts as Workspace settings › General; a walkthrough step opens other places in a new tab
            // (design principles 14 and 18).
            help={
              <T
                k="settings.general.language.help"
                values={{ link: appLink(sectionHash('account', 'preferences'), { newTab: true }) }}
              />
            }
            tip={{
              text: (
                <T
                  k="settings.general.language.tip"
                  values={{
                    languages: appLink(sectionHash('assistant', 'general'), { newTab: true }),
                    voice: appLink(sectionHash('assistant', 'general'), { newTab: true }),
                  }}
                />
              ),
            }}
          >
            <SearchSelect
              id="ob-biz-language"
              label={t('settings.general.language.label')}
              value={language}
              options={languageChoices}
              placeholder={t('settings.general.language.search')}
              onChange={setPickedLanguage}
            />
          </Field>
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
        {/* The greeting with the business's name is saved too; the owner hears and edits it in the next step. */}
        {fromGoogle && <GoogleMapsCredit />}
      </div>
      <Foot onBack={onBack} onContinue={save} canContinue={!problem} label={t('onboarding.business.review.save')} />
    </>
  )
}
