// The onboarding phone step for a country whose carrier checks documents first (docs/numbers-kyc.md; Germany first):
// the business details, the number's area (the area of the address suggested first), the documents, then the review.
// The setup goes on while the carrier decides (usually 1–3 business days): the number connects itself once approved.
// Built from the same form pieces and model as Settings › Phone numbers (NumberRequestForm.tsx,
// numberRequestModel.ts, numberRequestQueries.ts), one step at a time; data-driven by country, so the UK and Ireland
// reuse it.
import {
  type KycCountry,
  NUMBER_COUNTRIES,
  type NumberArea,
  phoneCountryName,
  type RegulatoryProfileData,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { Foot, useStepKeys } from '../onboarding/Frame.tsx'
import { ACCOUNT, loadAccount } from '../settings/account/account-api.ts'
import { rejectionReason as errorText } from '../shell/rejections.ts'
import { useAssistantName } from '../store.tsx'
import { tabWorkspace } from '../tabWorkspace.ts'
import { Note } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import {
  AreaPicker,
  BusinessProfileFields,
  createProblemText,
  RequiredDocuments,
  reasonText,
  requestAreaName,
} from './NumberRequestForm.tsx'
import {
  type DraftField,
  type DraftProblem,
  draftOf,
  forgetUnsentDraft,
  keepUnsentDraft,
  unsentDraft,
  missingDocuments,
  nationalPrefix,
  type ProfileDraft,
  profileFromDraft,
  type RequestRow,
  sameProfile,
  shownFields,
} from './numberRequestModel.ts'
import {
  createRequest,
  refreshRequest,
  saveProfile,
  useNumberRequirements,
  useRegulatoryProfile,
  useRequestView,
} from './numberRequestQueries.ts'

type Props = {
  country: KycCountry
  /** What the app knows already, to prefill the business details (the contact is who is signed in). */
  known: { businessName: string; phone: string }
  /** A number already in the carrier account (instance admins): the plain phone step's way to connect it. */
  onExisting?: () => void
  onBack: () => void
  onNext: () => void
}

type Stage = 'company' | 'area' | 'documents'
const STAGES: readonly Stage[] = ['company', 'area', 'documents']
const STAGE_NAMES: Record<Stage, MessageKey> = {
  company: msg('onboarding.numberRequest.stage.company'),
  area: msg('onboarding.numberRequest.stage.area'),
  documents: msg('onboarding.numberRequest.stage.documents'),
}

export function NumberRequestFlow(p: Props) {
  const t = useT()
  const requests = useRequestView(p.country)
  const profile = useRegulatoryProfile(true)
  // The contact person is who sets up, until the profile says otherwise; without the account the fields start empty.
  const account = useQuery(ACCOUNT, loadAccount, { persist: true })
  const accountKnown = !!account.data || !!account.error
  // Asked again after a rejection: the steps open with what was sent, to fix it.
  const [fixing, setFixing] = useState(false)
  const view = requests.view
  if (!view || !profile.data || !accountKnown)
    return (
      <>
        <div className="ob-body">
          <Loading
            what={t('onboarding.numberRequest.loading')}
            loading
            error={requests.error ?? profile.error}
            onRetry={() => void Promise.all([requests.reload(), profile.reload()])}
            skeleton={<SkeletonFields fields={4} />}
          />
        </div>
        <Foot onBack={p.onBack} onSkipStep={p.onNext} canContinue={false} />
      </>
    )
  if (view.kind === 'review') return <UnderReview {...p} request={view.request} />
  if (view.kind === 'rejected' && !fixing)
    return <Rejected request={view.request} onFix={() => setFixing(true)} onBack={p.onBack} onNext={p.onNext} />
  const user = account.data?.user
  return (
    <Steps
      {...p}
      saved={profile.data}
      owner={{ name: user?.name ?? '', email: user?.email ?? '' }}
      lastArea={
        view.kind === 'rejected'
          ? {
              prefix: view.request.prefix,
              name: requestAreaName(view.request),
              ...(view.request.city ? { city: view.request.city } : {}),
              popular: false,
              available: true,
            }
          : null
      }
    />
  )
}

/** The three steps before the request goes out; each keeps what was typed when going back and forth. */
function Steps(
  p: Props & { saved: RegulatoryProfileData; owner: { name: string; email: string }; lastArea: NumberArea | null },
) {
  const [stage, setStage] = useState<Stage>('company')
  // What was typed before the step was left comes back (unsentDraft), as the uploaded documents do.
  const [draft, setDraft] = useState<ProfileDraft>(
    () =>
      unsentDraft(tabWorkspace()) ??
      draftOf(p.saved.profile, {
        country: p.country,
        legalName: p.known.businessName,
        name: p.owner.name,
        email: p.owner.email,
        phone: p.known.phone,
      }),
  )
  // A suggestion, never a lock: the area of the address until one is picked by hand (or the one sent last time).
  const [area, setArea] = useState<NumberArea | null>(p.lastArea)
  const go = (to: Stage) => {
    setStage(to)
    window.scrollTo?.({ top: 0 })
  }
  if (stage === 'company')
    return (
      <Company
        {...p}
        draft={draft}
        onChange={change =>
          setDraft(d => {
            const changed = { ...d, ...change }
            keepUnsentDraft(tabWorkspace(), changed)
            return changed
          })
        }
        onSaved={() => go('area')}
      />
    )
  if (stage === 'area' || !area)
    return (
      <Area
        country={p.country}
        draft={draft}
        area={area}
        onPick={setArea}
        onBack={() => go('company')}
        onNext={() => area && go('documents')}
      />
    )
  return (
    <Documents
      country={p.country}
      draft={draft}
      prefix={area.prefix}
      documents={p.saved.documents}
      onBack={() => go('area')}
    />
  )
}

/** "Step 1 of 3 · Your company": where in the number's own steps this is. */
function StageLine({ stage }: { stage: Stage }) {
  const t = useT()
  return (
    <p className="nr-stage">
      {t('onboarding.numberRequest.stageOf', { at: STAGES.indexOf(stage) + 1, of: STAGES.length })}
      <span aria-hidden="true"> · </span>
      {t(STAGE_NAMES[stage])}
    </p>
  )
}

function Company({
  country,
  draft,
  saved,
  onChange,
  onSaved,
  onExisting,
  onBack,
  onNext,
}: Props & {
  draft: ProfileDraft
  saved: RegulatoryProfileData
  onChange: (change: Partial<ProfileDraft>) => void
  onSaved: () => void
}) {
  const t = useT()
  const fields = NUMBER_COUNTRIES[country].fields
  const shown = useMemo(() => shownFields(fields), [fields])
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const result = profileFromDraft(draft, fields)
  const problems: Partial<Record<DraftField, DraftProblem>> = tried && 'problems' in result ? result.problems : {}
  const countryName = phoneCountryName(country, i18n())
  // The number is the one the plan includes, like a US number; an install may waive the fee of such numbers.
  const waived = useNumberRequirements(country).data?.monthlyFeeWaived

  async function save() {
    if (saving) return
    setTried(true)
    if ('problems' in result) return
    setSaving(true)
    setProblem(null)
    try {
      if (!sameProfile(saved.profile, result.input)) await saveProfile(result.input)
      onSaved()
    } catch (e) {
      setProblem(t('onboarding.numberRequest.saveFailed', { reason: errorText((e as Error).message) }))
    } finally {
      setSaving(false)
    }
  }
  useStepKeys({ onEnter: () => void save(), onEscape: onBack })

  return (
    <>
      <div className="ob-body">
        <StageLine stage="company" />
        <h1>{t('onboarding.numberRequest.company.title', { country: countryName })}</h1>
        <p className="ob-lede">{t('onboarding.numberRequest.company.lede', { country: countryName })}</p>
        {waived !== undefined && (
          <p className="ob2-note">
            {waived ? t('onboarding.numberRequest.company.noFee') : t('onboarding.numberRequest.company.included')}
          </p>
        )}
        <BusinessProfileFields
          idPrefix="nr"
          draft={draft}
          onChange={onChange}
          shown={shown}
          problems={problems}
          country={country}
          disabled={saving}
        />
        {problem && <Note tone="danger">{problem}</Note>}
        {onExisting && (
          <button type="button" className="ob-link" onClick={onExisting}>
            {t('onboarding.numberRequest.existing')}
          </button>
        )}
      </div>
      <Foot
        onBack={onBack}
        onSkipStep={onNext}
        laterTitle={t('onboarding.numberRequest.laterTitle')}
        onContinue={() => void save()}
        busy={saving}
      />
    </>
  )
}

function Area({
  country,
  draft,
  area,
  onPick,
  onBack,
  onNext,
}: {
  country: KycCountry
  draft: ProfileDraft
  area: NumberArea | null
  onPick: (area: NumberArea) => void
  onBack: () => void
  onNext: () => void
}) {
  const t = useT()
  useStepKeys({ onEnter: onNext, onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <StageLine stage="area" />
        <h1>{t('onboarding.numberRequest.area.title')}</h1>
        <p className="ob-lede">{t('onboarding.numberRequest.area.lede')}</p>
        <AreaPicker id="nr-number-area" country={country} address={draft} value={area} onChange={onPick} />
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue={!!area} />
    </>
  )
}

function Documents({
  country,
  draft,
  prefix,
  documents: initial,
  onBack,
}: {
  country: KycCountry
  draft: ProfileDraft
  prefix: string
  documents: RegulatoryProfileData['documents']
  onBack: () => void
}) {
  const t = useT()
  const profile = useRegulatoryProfile(true)
  const documents = profile.data?.documents ?? initial
  const kinds = NUMBER_COUNTRIES[country].documents
  const missing = missingDocuments(kinds, documents)
  const [tried, setTried] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function send() {
    if (sending) return
    setTried(true)
    if (missing.length) return
    setSending(true)
    setProblem(null)
    try {
      // The request shows at once in the list the step reads: it turns into the review.
      await createRequest(country, prefix)
      forgetUnsentDraft(tabWorkspace())
    } catch (e) {
      setProblem(createProblemText(e))
      setSending(false)
    }
  }
  useStepKeys({ onEnter: () => void send(), onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <StageLine stage="documents" />
        <h1>{t('onboarding.numberRequest.documents.title', { count: kinds.length })}</h1>
        <p className="ob-lede">{t('settings.phone.request.documents.help')}</p>
        <RequiredDocuments
          idPrefix="nr"
          kinds={kinds}
          documents={documents}
          showMissing={tried}
          disabled={sending}
          draft={draft}
          plain
        />
        {problem && <Note tone="danger">{problem}</Note>}
      </div>
      <Foot
        onBack={onBack}
        onContinue={() => void send()}
        busy={sending}
        hint={missing.length ? t('onboarding.numberRequest.documents.missing') : undefined}
        label={t('onboarding.numberRequest.documents.send')}
      />
    </>
  )
}

/** The requests being asked about right now (the server answers a second question with 409 while one runs). */
const refreshing = new Set<string>()

function UnderReview({ request, onBack, onNext }: Props & { request: RequestRow }) {
  const t = useT()
  const assistant = useAssistantName()
  const [checking, setChecking] = useState(false)
  const city = requestAreaName(request)
  const approved = request.status === 'approved' || request.status === 'needs_operator'
  useStepKeys({ onEnter: onNext, onEscape: onBack })
  // Nothing asks the carrier on a schedule (its only notification is a completed order): opening this asks it now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per request shown
  useEffect(() => {
    void check()
  }, [request.id])
  async function check() {
    if (refreshing.has(request.id)) return
    refreshing.add(request.id)
    setChecking(true)
    try {
      await refreshRequest(request.id)
    } catch {
      // Asked again later; the carrier also tells the server by itself.
    } finally {
      refreshing.delete(request.id)
      setChecking(false)
    }
  }
  return (
    <>
      <div className="ob-body">
        <h1>
          {approved
            ? t('onboarding.numberRequest.review.approvedTitle', { city })
            : t('onboarding.numberRequest.review.title', { city })}
        </h1>
        <p className="ob-lede">
          {approved
            ? t('onboarding.numberRequest.review.approvedLede')
            : t('onboarding.numberRequest.review.lede', { assistant })}
        </p>
        <dl className="nr-facts">
          <div>
            <dt>{t('onboarding.numberRequest.review.number')}</dt>
            <dd>{t('onboarding.numberRequest.review.numberValue', { city, code: nationalPrefix(request.prefix) })}</dd>
          </div>
          <div>
            <dt>{t('onboarding.numberRequest.review.sent')}</dt>
            <dd>{fmt().date(new Date(request.createdAt), { dateStyle: 'medium' })}</dd>
          </div>
          <div>
            <dt>{t('onboarding.numberRequest.review.status')}</dt>
            <dd>
              {approved
                ? t('onboarding.numberRequest.review.statusApproved')
                : t('onboarding.numberRequest.review.statusOpen')}
            </dd>
          </div>
        </dl>
        <button type="button" className="ob-link" onClick={() => void check()} disabled={checking}>
          {checking ? t('onboarding.numberRequest.review.checking') : t('onboarding.numberRequest.review.check')}
        </button>
      </div>
      <Foot onBack={onBack} onContinue={onNext} />
    </>
  )
}

function Rejected({
  request,
  onFix,
  onBack,
  onNext,
}: {
  request: RequestRow
  onFix: () => void
  onBack: () => void
  onNext: () => void
}) {
  const t = useT()
  useStepKeys({ onEnter: onFix, onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <h1>{t('onboarding.numberRequest.rejected.title')}</h1>
        <Note tone="danger" title={t('onboarding.numberRequest.rejected.reason')}>
          {reasonText(request.reason)}
        </Note>
        <p className="ob-lede">{t('onboarding.numberRequest.rejected.lede')}</p>
      </div>
      <Foot
        onBack={onBack}
        onSkipStep={onNext}
        laterTitle={t('onboarding.numberRequest.laterTitle')}
        onContinue={onFix}
        label={t('onboarding.numberRequest.rejected.fix')}
      />
    </>
  )
}
