// The pieces of a number request form (docs/numbers-kyc.md), the one set shared by Settings › Phone numbers
// (settings/NumberRequests.tsx) and the onboarding phone step (NumberRequestFlow.tsx): the area search (the area of
// the business address picked first, never locked), the business profile fields (who holds the number, the address, a contact
// person) and the documents the carrier wants, listed by name with upload and delete, the BNetzA form downloadable
// filled in. Each piece is controlled by its screen, which decides when the profile is saved and the request is sent.
import {
  KYC_COUNTRIES,
  type KycCountry,
  NUMBER_COUNTRIES,
  type NumberArea,
  type RegulatoryDocumentKind,
  type RegulatoryDocumentSummary,
  type RegulatoryEntityType,
  regulatoryDocumentTypes,
  regulatoryEntityTypes,
} from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useEffect, useRef, useState } from 'react'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { CountrySelect } from '../settings/CountrySelect.tsx'
import { Field, TextInput } from '../settings/fields.tsx'
import { RadioCard, Select } from '../ui/controls.tsx'
import { Input } from '../ui/form.tsx'
import { Badge, Button, Icon, Note } from '../ui/kit.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { downloadBnetzaForm } from './bnetzaForm.ts'
import {
  ADDRESS_ORDER,
  areaAwayFromAddress,
  type DraftField,
  type DraftProblem,
  documentProblem,
  documentsByKind,
  fileSize,
  listedAreas,
  nationalPrefix,
  type ProfileDraft,
  type RequestRow,
  rejectionReason,
} from './numberRequestModel.ts'
import { deleteDocument, uploadDocument, useNumberAreas } from './numberRequestQueries.ts'
import './number-request.css'

const KNOWN_CITIES = new Set(KYC_COUNTRIES.flatMap(c => NUMBER_COUNTRIES[c].cities.map(city => city.id)))

/** A city's name in the reader's language ("Munich", "München"); a city the catalog does not name, its id. */
export const cityName = (city: string) =>
  KNOWN_CITIES.has(city)
    ? // i18n-dynamic: settings.phone.request.city.*
      i18n().t(`settings.phone.request.city.${city}` as MessageKey)
    : city

/** An area's name: a popular city in the reader's language ("Munich"), else the area's own ("Heidelberg"). */
export const areaTitle = (area: Pick<NumberArea, 'city' | 'name'>) => (area.city ? cityName(area.city) : area.name)

/** The area of a request: its popular city's name, else the area's own name, else the area code (06221). */
export const requestAreaName = (request: Pick<RequestRow, 'city' | 'areaName' | 'prefix'>) =>
  request.city ? cityName(request.city) : (request.areaName ?? nationalPrefix(request.prefix))

/** Why the server would not send a request, in calm words for the codes the app knows; else the server's own. */
export function createProblemText(error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  const known: Record<string, MessageKey> = {
    number_request_unknown_area: 'settings.phone.request.problem.unknownArea',
    number_request_no_local_numbers: 'settings.phone.request.problem.noLocalNumbers',
    number_request_no_numbers: 'settings.phone.request.problem.noNumbers',
  }
  if (code && known[code]) return i18n().t(known[code])
  return error instanceof Error ? error.message : String(error)
}

/** The value once it stopped changing for a moment (typing): one search, not one per key. */
function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/**
 * The area search: a place, an area code or a postcode finds the areas a number can be asked for
 * (numberRequest.areas); empty, the available ones, popular first. The area of the business address is listed first
 * and picked while nothing else is. An area without local numbers yet stays in the list, greyed, and cannot be
 * picked. Another area than the address's can be picked; a calm line says what the proof of address then needs.
 */
export function AreaPicker({
  id,
  country,
  address,
  value,
  onChange,
  disabled,
}: {
  id: string
  country: KycCountry
  /** The business address, for the suggestion (its city and postal code). */
  address: { city: string; postal_code: string }
  value: NumberArea | null
  onChange: (area: NumberArea) => void
  disabled?: boolean
}) {
  const t = useT()
  const [typed, setTyped] = useState('')
  const query = useSettled(typed)
  const place = useSettled(`${address.postal_code.trim()}\n${address.city.trim()}`)
  const [postal_code = '', city = ''] = place.split('\n')
  const at = { postal_code, city }
  const base = useNumberAreas(country, '', at)
  const search = useNumberAreas(country, query, at)
  // While a new search runs, the last answer stays (no flicker to empty).
  const last = useRef(search.data)
  if (search.data) last.current = search.data
  const found = search.data ?? last.current
  const suggested = base.data?.suggested ?? []
  const first = suggested.find(a => a.available)
  useEffect(() => {
    if (!value && first) onChange(first)
  }, [value, first, onChange])

  const areas = found ? listedAreas(found.areas, suggested, value, query) : []
  const greyed = areas.some(a => !a.available)
  const away = value ? areaAwayFromAddress(value.prefix, suggested) : false
  const describe = (area: NumberArea) =>
    [
      nationalPrefix(area.prefix),
      area.place && area.place !== area.name ? t('settings.phone.request.area.includes', { place: area.place }) : null,
      suggested.some(s => s.prefix === area.prefix) ? t('settings.phone.request.area.yourAddress') : null,
      area.available ? null : t('settings.phone.request.area.notYet'),
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <div className="nr-area">
      <Input
        id={id}
        type="search"
        value={typed}
        disabled={disabled}
        placeholder={t('settings.phone.request.area.search')}
        aria-label={t('settings.phone.request.area.search')}
        autoComplete="off"
        onChange={e => setTyped(e.target.value)}
      />
      {!found ? (
        <p className="help">{search.error ?? t('settings.phone.request.area.loading')}</p>
      ) : areas.length === 0 ? (
        <p className="help">{t('settings.phone.request.area.none', { query: query.trim() })}</p>
      ) : (
        <div className="k-radios nr-areas" role="radiogroup" aria-label={t('settings.phone.request.area.label')}>
          {areas.map(area => (
            <RadioCard
              key={area.prefix}
              name={`${id}-area`}
              checked={value?.prefix === area.prefix}
              disabled={disabled || !area.available}
              onPick={() => onChange(area)}
              title={areaTitle(area)}
              description={describe(area)}
            />
          ))}
        </div>
      )}
      {greyed && <p className="help nr-hint">{t('settings.phone.request.area.greyed')}</p>}
      {away && value && (
        <Note tone="info" role="status">
          {t('settings.phone.request.area.away', { area: areaTitle(value) })}
        </Note>
      )}
    </div>
  )
}

/** A rejection's reason in the reader's words, or the carrier's own. */
export function reasonText(reason: string | null) {
  const r = rejectionReason(reason)
  // i18n-dynamic: settings.phone.request.reason.*
  return 'key' in r ? i18n().t(`settings.phone.request.reason.${r.key}` as MessageKey) : r.text
}

/** A field's problem in words. */
function problemText(problem: DraftProblem | undefined): string | null {
  if (!problem) return null
  // i18n-dynamic: settings.phone.request.problem.*
  return i18n().t(`settings.phone.request.problem.${problem}`)
}

type ProfileProps = {
  idPrefix: string
  draft: ProfileDraft
  onChange: (change: Partial<ProfileDraft>) => void
  /** The fields to show (shownFields): the optional ones only where the country asks for them. */
  shown: ReadonlySet<DraftField>
  problems: Partial<Record<DraftField, DraftProblem>>
  /** The number's country: the contact phone starts there. */
  country: KycCountry
  disabled?: boolean
}

/** Who holds the number: the business, its address and a contact person, in three short groups. */
export function BusinessProfileFields({ idPrefix, draft, onChange, shown, problems, country, disabled }: ProfileProps) {
  const t = useT()
  const id = (field: string) => `${idPrefix}-${field}`
  const text = (field: DraftField, label: string, extra: { help?: string; optional?: boolean } = {}) => (
    <Field
      id={id(field)}
      label={label}
      help={extra.help}
      aside={extra.optional ? t('settings.phone.request.optional') : undefined}
      error={problemText(problems[field])}
    >
      <TextInput
        id={id(field)}
        value={draft[field]}
        invalid={!!problems[field]}
        disabled={disabled}
        onChange={value => onChange({ [field]: value })}
      />
    </Field>
  )
  return (
    <>
      <fieldset className="nr-group">
        <legend>{t('settings.phone.request.business')}</legend>
        {text('legal_name', t('settings.phone.request.legalName'), { help: t('settings.phone.request.legalNameHelp') })}
        <Field id={id('entity_type')} label={t('settings.phone.request.entityType')}>
          <div>
            <Select
              id={id('entity_type')}
              label={t('settings.phone.request.entityType')}
              value={draft.entity_type}
              disabled={disabled}
              options={regulatoryEntityTypes.map((type: RegulatoryEntityType) => ({
                value: type,
                // i18n-dynamic: settings.phone.request.entity.*
                label: t(`settings.phone.request.entity.${type}`),
              }))}
              onChange={entity_type => onChange({ entity_type })}
            />
          </div>
        </Field>
        {shown.has('registration_number') && (
          <>
            <div className="nr-pair">
              {text('registration_number', t('settings.phone.request.registrationNumber'))}
              {shown.has('register_court') &&
                text('register_court', t('settings.phone.request.registerCourt'), { optional: true })}
            </div>
            <p className="help nr-hint">{t('settings.phone.request.registrationNumberHelp')}</p>
          </>
        )}
        {shown.has('website') && text('website', t('settings.phone.request.website'))}
        {shown.has('use_case') &&
          text('use_case', t('settings.phone.request.useCase'), { help: t('settings.phone.request.useCaseHelp') })}
      </fieldset>
      <fieldset className="nr-group">
        <legend>{t('settings.phone.request.address')}</legend>
        {NUMBER_COUNTRIES[country].addressInArea && (
          <p className="help nr-hint">{t('settings.phone.request.addressHelp')}</p>
        )}
        {text('street', t('settings.phone.request.street'))}
        {text('extended', t('settings.phone.request.extended'), { optional: true })}
        {ADDRESS_ORDER[country] === 'postcode_first' ? (
          <div className="nr-pair nr-pair-postal">
            {text('postal_code', t('settings.phone.request.postalCode'))}
            {text('city', t('settings.phone.request.addressCity'))}
          </div>
        ) : (
          <div className="nr-pair nr-pair-postal-last">
            {text('city', t('settings.phone.request.addressCity'))}
            {text('postal_code', t('settings.phone.request.postalCode'))}
          </div>
        )}
        <Field
          id={id('country')}
          label={t('settings.phone.request.addressCountry')}
          error={problemText(problems.country)}
        >
          <CountrySelect
            id={id('country')}
            value={draft.country}
            disabled={disabled}
            onChange={value => onChange({ country: value })}
          />
        </Field>
      </fieldset>
      <fieldset className="nr-group">
        <legend>{t('settings.phone.request.contact')}</legend>
        <div className="nr-pair">
          {text('first_name', t('settings.phone.request.firstName'))}
          {text('last_name', t('settings.phone.request.lastName'))}
        </div>
        {text('email', t('settings.phone.request.email'))}
        <Field id={id('phone')} label={t('settings.phone.request.phone')} error={problemText(problems.phone)}>
          <PhoneInput
            id={id('phone')}
            value={draft.phone}
            defaultCountry={country}
            invalid={!!problems.phone}
            disabled={disabled}
            onChange={phone => onChange({ phone })}
          />
        </Field>
      </fieldset>
    </>
  )
}

type DocumentsProps = {
  idPrefix: string
  /** The kinds the country needs, in its order. */
  kinds: readonly RegulatoryDocumentKind[]
  documents: readonly RegulatoryDocumentSummary[]
  /** The kinds still missing are marked once the form was sent with them missing. */
  showMissing?: boolean
  disabled?: boolean
  /** Owners and admins only; members see the names. */
  canEdit?: boolean
  /** The business as typed so far: the BNetzA form downloads filled in with it. */
  draft: ProfileDraft
  /** Without the group's own heading and help (the onboarding step says it in its title). */
  plain?: boolean
}

/**
 * One row per document the country needs: its name and what it is, the files uploaded for it (by name; the newest is
 * the one sent) with a delete button each, and Upload. A file is checked here first (PDF, PNG or JPEG, at most
 * 2.5 MB) and uploaded at once.
 */
export function RequiredDocuments({
  idPrefix,
  kinds,
  documents,
  showMissing,
  disabled,
  canEdit = true,
  draft,
  plain,
}: DocumentsProps) {
  const t = useT()
  const format = useFormat()
  const input = useRef<HTMLInputElement>(null)
  const [uploadingKind, setUploadingKind] = useState<RegulatoryDocumentKind | null>(null)
  const [pickingKind, setPickingKind] = useState<RegulatoryDocumentKind | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ kind: RegulatoryDocumentKind; text: string } | null>(null)

  function pick(kind: RegulatoryDocumentKind) {
    setPickingKind(kind)
    setProblem(null)
    input.current?.click()
  }
  async function upload(file: File | undefined) {
    const kind = pickingKind
    if (input.current) input.current.value = ''
    if (!file || !kind) return
    const wrong = documentProblem(file)
    if (wrong) {
      // i18n-dynamic: settings.phone.request.documents.problem.*
      setProblem({ kind, text: t(`settings.phone.request.documents.problem.${wrong}`, { name: file.name }) })
      return
    }
    setUploadingKind(kind)
    try {
      await uploadDocument(kind, file, [...documents])
    } catch (e) {
      setProblem({ kind, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setUploadingKind(null)
    }
  }
  async function remove(document: RegulatoryDocumentSummary) {
    setDeleting(document.id)
    setProblem(null)
    try {
      await deleteDocument(document.id, [...documents])
    } catch (e) {
      setProblem({ kind: document.kind, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setDeleting(null)
    }
  }
  const size = (bytes: number) => {
    const { unit, value } = fileSize(bytes, format.number)
    // i18n-dynamic: settings.phone.request.documents.size.*
    return t(`settings.phone.request.documents.size.${unit}`, { size: value })
  }

  return (
    <fieldset className={plain ? 'nr-group nr-group-plain' : 'nr-group'}>
      <legend className={plain ? 'sr-only' : undefined}>{t('settings.phone.request.documents.title')}</legend>
      {!plain && <p className="help nr-hint">{t('settings.phone.request.documents.help')}</p>}
      <input
        ref={input}
        type="file"
        hidden
        accept={regulatoryDocumentTypes.join(',')}
        onChange={e => void upload(e.target.files?.[0])}
      />
      <ul className="nr-docs">
        {documentsByKind(kinds, documents).map(({ kind, documents: files }) => {
          const missing = showMissing && files.length === 0
          const busy = uploadingKind === kind
          return (
            <li key={kind} className="nr-doc" id={`${idPrefix}-doc-${kind}`}>
              <div className="nr-doc-head">
                <span className="nr-doc-t">
                  {/* i18n-dynamic: settings.phone.request.documents.kind.* */}
                  <b>{t(`settings.phone.request.documents.kind.${kind}.title`)}</b>
                  <span className="help">{t(`settings.phone.request.documents.kind.${kind}.help`)}</span>
                  {kind === 'bnetza_form' && <FormDownload draft={draft} />}
                </span>
                {missing && <Badge tone="danger">{t('settings.phone.request.documents.missing')}</Badge>}
                {canEdit && (
                  <Button
                    size="sm"
                    icon="attach"
                    busy={busy}
                    disabled={disabled || uploadingKind !== null}
                    onClick={() => pick(kind)}
                  >
                    {busy
                      ? t('settings.phone.request.documents.uploading')
                      : files.length
                        ? t('settings.phone.request.documents.replace')
                        : t('settings.phone.request.documents.upload')}
                  </Button>
                )}
              </div>
              {files.length > 0 && (
                <ul className="nr-files">
                  {files.map((file, i) => (
                    <li key={file.id} className={i > 0 ? 'nr-file is-older' : 'nr-file'}>
                      <Icon name="attach" size={14} />
                      <span className="nr-file-name" title={file.filename}>
                        {file.filename}
                      </span>
                      <span className="nr-file-meta">
                        {i === 0 && files.length > 1
                          ? t('settings.phone.request.documents.newest', { size: size(file.size) })
                          : size(file.size)}
                      </span>
                      {canEdit && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          busy={deleting === file.id}
                          disabled={disabled || deleting !== null}
                          aria-label={t('settings.phone.request.documents.delete', { name: file.filename })}
                          title={t('settings.phone.request.documents.delete', { name: file.filename })}
                          onClick={() => void remove(file)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {problem?.kind === kind && (
                <p className="k-field-msg" role="alert">
                  {problem.text}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

/** The BNetzA form, filled in with the business's details in the browser, to sign and upload. */
function FormDownload({ draft }: { draft: ProfileDraft }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  async function download() {
    setBusy(true)
    setFailed(false)
    try {
      await downloadBnetzaForm(
        {
          legalName: draft.legal_name.trim(),
          register: [draft.registration_number.trim(), draft.register_court.trim()].filter(Boolean).join(', '),
          signer: `${draft.first_name.trim()} ${draft.last_name.trim()}`.trim(),
          place: draft.city.trim(),
          date: fmt().date(new Date(), { dateStyle: 'medium' }),
          entityType: draft.entity_type,
        },
        t('settings.phone.request.documents.bnetzaForm.file'),
      )
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="nr-doc-extra">
      <Button size="sm" variant="secondary" busy={busy} onClick={() => void download()}>
        {t('settings.phone.request.documents.bnetzaForm.download')}
      </Button>
      {failed && (
        <span className="k-field-msg" role="alert">
          {t('settings.phone.request.documents.bnetzaForm.failed')}
        </span>
      )}
    </span>
  )
}
