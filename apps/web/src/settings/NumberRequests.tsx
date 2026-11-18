// Settings › Phone numbers, numbers in countries whose carrier checks documents first (docs/numbers-kyc.md): the
// requests under the numbers (in review, being set up, not approved with the carrier's reason), and the dialog that
// asks for one (city, business details, documents). Nothing shows while the server has no such country switched on
// (numberRequest.countries is empty). An approved request's number arrives in the list above like any number.
import {
  cityMatches,
  type KycCountry,
  NUMBER_COUNTRIES,
  nameInSentence,
  type RegulatoryProfileInput,
} from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { useStore } from '../store.tsx'
import { useTeam } from '../team/team-api.ts'
import { Select } from '../ui/controls.tsx'
import { Dialog } from '../ui/form.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { List, ListRow, MenuButton } from '../ui/list.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { Field } from './fields.tsx'
import { BusinessProfileFields, CityPicker, cityName, RequiredDocuments } from './NumberRequestForm.tsx'
import {
  addressOutsideCity,
  canCancel,
  canCheck,
  type DraftField,
  type DraftProblem,
  draftOf,
  holdReason,
  missingDocuments,
  type ProfileDraft,
  profileFromDraft,
  type RequestRow,
  rejectionReason,
  requestedNumber,
  requestStage,
  sameProfile,
  shownFields,
  shownRequests,
} from './numberRequestModel.ts'
import {
  cancelRequest,
  createRequest,
  refreshRequest,
  saveProfile,
  useNumberRequestCountries,
  useNumberRequests,
  useNumberRequirements,
  useRegulatoryProfile,
} from './numberRequestQueries.ts'

/** "Germany", "the United Kingdom": the country as it goes into a sentence, in the reader's language. */
export const countryInSentence = (country: string) => nameInSentence(country, i18n())

/** The open countries, for the section's button; empty while the server has none (or for a member). */
export function useRequestCountries(canEdit: boolean): KycCountry[] {
  return useNumberRequestCountries(canEdit).data?.countries ?? []
}

/** The rejection's reason in the reader's words, or the carrier's own. */
function reasonText(reason: string | null) {
  const r = rejectionReason(reason)
  // i18n-dynamic: settings.phone.request.reason.*
  return 'key' in r ? i18n().t(`settings.phone.request.reason.${r.key}` as MessageKey) : r.text
}

type Props = {
  canEdit: boolean
  /** The dialog is open (from the section's button), on this country. */
  requesting: KycCountry | null
  onRequesting: (country: KycCountry | null) => void
  countries: readonly KycCountry[]
}

/**
 * The requests under the numbers and the request dialog. Owners and admins act on them (check now, cancel, fix and
 * send again); anyone else who may read them sees where they stand.
 */
export function NumberRequests({ canEdit, requesting, onRequesting, countries }: Props) {
  const t = useT()
  const format = useFormat()
  const store = useStore()
  // Only owners and admins may read requests (settings:write); for a member the list is not asked for.
  const list = useNumberRequests(canEdit)
  const requests = list.data ?? []
  const shown = shownRequests(requests)
  /** The request being cancelled, asked first. */
  const [cancelling, setCancelling] = useState<RequestRow | null>(null)
  /** Sent again after a rejection: the dialog opens on its city. */
  const [again, setAgain] = useState<RequestRow | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null)

  // A request that became active while this page was open: its number arrives in the list above now, not at the next
  // poll of the numbers.
  const activeIds = requests
    .filter(r => r.status === 'active')
    .map(r => r.id)
    .join(' ')
  useEffect(() => {
    if (activeIds) void store.refresh(['phone_numbers'])
  }, [activeIds, store])

  // Nothing asks the carrier on a schedule: a request still being decided or set up is checked once when the page
  // shows it (one after another, as each takes the workspace's carrier lock). A failure stays quiet, Check now tells.
  const checked = useRef(new Set<string>())
  const toCheck = canEdit
    ? requests
        .filter(r => canCheck(r.status) && !checked.current.has(r.id))
        .map(r => r.id)
        .join(' ')
    : ''
  useEffect(() => {
    if (!toCheck) return
    const ids = toCheck.split(' ')
    for (const id of ids) checked.current.add(id)
    void (async () => {
      for (const id of ids) await refreshRequest(id).catch(() => null)
    })()
  }, [toCheck])

  async function check(request: RequestRow) {
    setChecking(request.id)
    setProblem(null)
    try {
      await refreshRequest(request.id)
    } catch (e) {
      setProblem({ id: request.id, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setChecking(null)
    }
  }

  const dialogCountry = again?.country ?? requesting
  return (
    <>
      {shown.length > 0 && (
        <div className="nr-requests">
          <h3 className="nr-requests-title">{t('settings.phone.request.listTitle')}</h3>
          <List label={t('settings.phone.request.listTitle')}>
            {shown.map(r => (
              <ListRow
                key={r.id}
                title={<span className="st-mono">{requestedNumber(r.country, r.prefix, r.e164)}</span>}
                sub={t('settings.phone.request.row.sub', {
                  city: cityName(r.city),
                  country: countryInSentence(r.country),
                  date: format.date(new Date(r.createdAt)),
                })}
                aside={<RequestBadge request={r} />}
                actions={
                  canEdit && (
                    <RequestActions
                      request={r}
                      checking={checking === r.id}
                      onCheck={() => void check(r)}
                      onCancel={() => setCancelling(r)}
                      onAgain={() => setAgain(r)}
                    />
                  )
                }
                below={<RequestDetail request={r} problem={problem?.id === r.id ? problem.text : null} />}
              />
            ))}
          </List>
        </div>
      )}
      {dialogCountry && canEdit && (
        <RequestDialog
          countries={countries.length ? countries : [dialogCountry]}
          initialCountry={dialogCountry}
          initialPrefix={again?.prefix ?? ''}
          onClose={() => {
            setAgain(null)
            onRequesting(null)
          }}
        />
      )}
      {cancelling && <CancelDialog request={cancelling} onClose={() => setCancelling(null)} />}
    </>
  )
}

/** Where a request stands, in one short badge. */
function RequestBadge({ request }: { request: RequestRow }) {
  const t = useT()
  const stage = requestStage(request.status)
  if (stage === 'rejected')
    return (
      <Badge tone="danger">
        <StatusMark state="failing" label={t('settings.phone.request.status.rejected')} />
        {t('settings.phone.request.status.rejected')}
      </Badge>
    )
  const label =
    stage === 'onHold'
      ? t('settings.phone.request.status.onHold')
      : stage === 'settingUp'
        ? t('settings.phone.request.status.settingUp')
        : t('settings.phone.request.status.review')
  return (
    <Badge tone={stage === 'onHold' ? 'warning' : undefined}>
      <StatusMark state={stage === 'review' ? 'untested' : 'partly'} label={label} />
      {label}
    </Badge>
  )
}

/** The line under a request: what happens next, or why it was not approved. */
function RequestDetail({ request, problem }: { request: RequestRow; problem: string | null }) {
  const t = useT()
  const stage = requestStage(request.status)
  return (
    <div className="nr-detail">
      {stage === 'rejected' ? (
        <p className="nr-reason">
          <span className="nr-reason-label">{t('settings.phone.request.reasonLabel')}</span>{' '}
          {reasonText(request.reason)}
        </p>
      ) : (
        <p className="help">
          {stage === 'onHold'
            ? // i18n-dynamic: settings.phone.request.hold.*
              t(`settings.phone.request.hold.${holdReason(request.reason)}` as MessageKey)
            : stage === 'settingUp'
              ? t('settings.phone.request.settingUpHelp')
              : t('settings.phone.request.reviewHelp')}
        </p>
      )}
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

function RequestActions({
  request,
  checking,
  onCheck,
  onCancel,
  onAgain,
}: {
  request: RequestRow
  checking: boolean
  onCheck: () => void
  onCancel: () => void
  onAgain: () => void
}) {
  const t = useT()
  const city = cityName(request.city)
  if (requestStage(request.status) === 'rejected')
    return (
      <Button size="sm" variant="primary" onClick={onAgain}>
        {t('settings.phone.request.again')}
      </Button>
    )
  const items = [
    ...(canCheck(request.status)
      ? [{ id: 'check', label: t('settings.phone.request.row.check'), onSelect: onCheck }]
      : []),
    ...(canCancel(request.status)
      ? [{ id: 'cancel', label: t('settings.phone.request.row.cancel'), danger: true, onSelect: onCancel }]
      : []),
  ]
  if (checking) return <Button size="sm" variant="ghost" busy aria-label={t('settings.phone.request.row.checking')} />
  if (!items.length) return null
  return <MenuButton title={t('settings.phone.request.row.actions', { city })} items={items} />
}

/** Cancelling asks first: the review stops and the number is not reserved any more. */
function CancelDialog({ request, onClose }: { request: RequestRow; onClose: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function cancel() {
    setBusy(true)
    setProblem(null)
    try {
      await cancelRequest(request.id)
      onClose()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      size="sm"
      title={t('settings.phone.request.cancel.title', { city: cityName(request.city) })}
      description={t('settings.phone.request.cancel.help')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('settings.phone.request.cancel.keep')}
          </Button>
          <Button variant="danger" busy={busy} onClick={() => void cancel()}>
            {t('settings.phone.request.cancel.confirm')}
          </Button>
        </>
      }
    >
      {problem && <Note tone="danger">{problem}</Note>}
    </Dialog>
  )
}

type DialogProps = {
  countries: readonly KycCountry[]
  initialCountry: KycCountry
  /** The city to start on (sent again after a rejection); '' for none. */
  initialPrefix: string
  onClose: () => void
}

/**
 * Asks for a number: the city, the business details (prefilled from the saved profile) and the documents. Sending
 * saves the profile when it changed, then sends the request; the dialog closes on the request's line under the numbers.
 */
function RequestDialog({ countries, initialCountry, initialPrefix, onClose }: DialogProps) {
  const t = useT()
  const team = useTeam().data
  const me = team?.members.find(m => m.userId === team.me)
  const [country, setCountry] = useState<KycCountry>(initialCountry)
  const [prefix, setPrefix] = useState(initialPrefix)
  const requirements = useNumberRequirements(country).data
  const profileQuery = useRegulatoryProfile(true)
  const saved = profileQuery.data
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [problems, setProblems] = useState<Partial<Record<DraftField, DraftProblem>>>({})
  const [tried, setTried] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // The form starts from the saved profile once it is here, else from what the workspace already knows.
  useEffect(() => {
    if (draft || !saved) return
    setDraft(
      draftOf(saved.profile, {
        country: initialCountry,
        email: me?.email,
        name: me?.name,
      }),
    )
  }, [draft, saved, initialCountry, me])

  // A suggestion, never a lock: the city of the business address when numbers there can be requested, until a city
  // is picked by hand.
  const [pickedCity, setPickedCity] = useState(!!initialPrefix)
  const addressCity = draft?.city ?? ''
  useEffect(() => {
    if (pickedCity || !addressCity.trim()) return
    const match = NUMBER_COUNTRIES[country].cities.find(c => cityMatches(c, addressCity))
    if (match) setPrefix(match.prefix)
  }, [pickedCity, addressCity, country])

  const fields = requirements?.fields ?? NUMBER_COUNTRIES[country].fields
  const kinds = requirements?.documents ?? NUMBER_COUNTRIES[country].documents
  const cities = requirements?.cities ?? NUMBER_COUNTRIES[country].cities
  const shown = useMemo(() => shownFields(fields), [fields])
  const documents = saved?.documents ?? []
  const missing = missingDocuments(kinds, documents)
  const outside = draft && prefix ? addressOutsideCity(country, prefix, draft.city) : false

  function change(next: Partial<ProfileDraft>) {
    setDraft(d => (d ? { ...d, ...next } : d))
    if (tried) setProblems(p => Object.fromEntries(Object.entries(p).filter(([k]) => !(k in next))))
    setProblem(null)
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!draft || sending) return
    setTried(true)
    const result = profileFromDraft(draft, fields)
    const formProblems = 'problems' in result ? result.problems : {}
    setProblems(formProblems)
    if (!prefix) return setProblem(t('settings.phone.request.problem.city'))
    if ('problems' in result) return setProblem(t('settings.phone.request.problem.fields'))
    if (missing.length) return setProblem(t('settings.phone.request.problem.documents'))
    setSending(true)
    setProblem(null)
    try {
      if (!sameProfile(saved?.profile ?? null, result.input as RegulatoryProfileInput)) await saveProfile(result.input)
      await createRequest(country, prefix)
      onClose()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
      setSending(false)
    }
  }

  return (
    <Dialog
      size="md"
      title={t('settings.phone.request.dialog.title', { country: countryInSentence(country) })}
      description={t('settings.phone.request.dialog.description', { country: countryInSentence(country) })}
      onClose={onClose}
      onSubmit={e => void send(e)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            {t('common.action.cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={sending} disabled={!draft}>
            {sending ? t('settings.phone.request.dialog.sending') : t('settings.phone.request.dialog.send')}
          </Button>
        </>
      }
    >
      {countries.length > 1 && (
        <Field id="nr-country" label={t('settings.phone.request.country')}>
          <div>
            <Select
              id="nr-country"
              label={t('settings.phone.request.country')}
              value={country}
              disabled={sending}
              options={countries.map(c => ({ value: c, label: countryInSentence(c) }))}
              onChange={next => {
                setCountry(next)
                setPrefix('')
              }}
            />
          </div>
        </Field>
      )}
      <Field
        id="nr-number-city"
        label={t('settings.phone.request.city')}
        error={tried && !prefix ? t('settings.phone.request.problem.required') : null}
      >
        <div>
          <CityPicker
            id="nr-number-city"
            cities={cities}
            value={prefix}
            onChange={next => {
              setPickedCity(true)
              setPrefix(next)
            }}
            disabled={sending}
          />
        </div>
      </Field>
      {!draft ? (
        <p className="help">{profileQuery.error ?? t('settings.phone.request.dialog.loading')}</p>
      ) : (
        <>
          <BusinessProfileFields
            idPrefix="nr"
            draft={draft}
            onChange={change}
            shown={shown}
            problems={problems}
            country={country}
            disabled={sending}
          />
          {outside && (
            <Note tone="warning">
              {t('settings.phone.request.outsideArea', {
                city: cityName(cities.find(c => c.prefix === prefix)?.id ?? ''),
                addressCity: draft.city.trim(),
              })}
            </Note>
          )}
          <RequiredDocuments idPrefix="nr" kinds={kinds} documents={documents} showMissing={tried} disabled={sending} />
        </>
      )}
      {problem && <Note tone="danger">{problem}</Note>}
    </Dialog>
  )
}
