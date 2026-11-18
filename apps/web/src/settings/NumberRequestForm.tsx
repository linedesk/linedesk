// The pieces of a number request form (docs/numbers-kyc.md), shared by Settings › Phone numbers (NumberRequests.tsx)
// and the onboarding phone step: the city picker, the business profile fields (who holds the number, the address,
// a contact person) and the documents the carrier wants, listed by name with upload and delete. Each piece is
// controlled by its screen, which decides when the profile is saved and the request is sent.
import {
  KYC_COUNTRIES,
  type KycCountry,
  NUMBER_COUNTRIES,
  type NumberCity,
  type RegulatoryDocumentKind,
  type RegulatoryDocumentSummary,
  type RegulatoryEntityType,
  regulatoryDocumentTypes,
  regulatoryEntityTypes,
} from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useRef, useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { Select } from '../ui/controls.tsx'
import { Badge, Button, Icon } from '../ui/kit.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { CountrySelect } from './CountrySelect.tsx'
import { Field, TextInput } from './fields.tsx'
import {
  type DraftField,
  type DraftProblem,
  documentProblem,
  documentsByKind,
  fileSize,
  nationalPrefix,
  type ProfileDraft,
} from './numberRequestModel.ts'
import { deleteDocument, uploadDocument } from './numberRequestQueries.ts'
import './number-requests.css'

const KNOWN_CITIES = new Set(KYC_COUNTRIES.flatMap(c => NUMBER_COUNTRIES[c].cities.map(city => city.id)))

/** A city's name in the reader's language ("Munich", "München"); a city the catalog does not name, its id. */
export const cityName = (city: string) =>
  KNOWN_CITIES.has(city)
    ? // i18n-dynamic: settings.phone.request.city.*
      i18n().t(`settings.phone.request.city.${city}` as MessageKey)
    : city

/** The city picker: "Berlin (030)", major cities first, as the country lists them. */
export function CityPicker({
  id,
  cities,
  value,
  onChange,
  disabled,
}: {
  id: string
  cities: readonly NumberCity[]
  /** The picked city's prefix (`30`), '' for none. */
  value: string
  onChange: (prefix: string) => void
  disabled?: boolean
}) {
  const t = useT()
  return (
    <Select
      id={id}
      label={t('settings.phone.request.city')}
      value={value}
      disabled={disabled}
      options={[
        ...(value ? [] : [{ value: '', label: t('settings.phone.request.cityPick'), disabled: true }]),
        ...cities.map(c => ({
          value: c.prefix,
          label: t('settings.phone.request.cityOption', { city: cityName(c.id), code: nationalPrefix(c.prefix) }),
        })),
      ]}
      onChange={onChange}
    />
  )
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
        <div className="nr-pair">
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
          {shown.has('registration_number') &&
            text('registration_number', t('settings.phone.request.registrationNumber'))}
        </div>
        {shown.has('registration_number') && (
          <p className="help nr-hint">{t('settings.phone.request.registrationNumberHelp')}</p>
        )}
        {shown.has('website') && text('website', t('settings.phone.request.website'))}
        {shown.has('use_case') &&
          text('use_case', t('settings.phone.request.useCase'), { help: t('settings.phone.request.useCaseHelp') })}
      </fieldset>
      <fieldset className="nr-group">
        <legend>{t('settings.phone.request.address')}</legend>
        {text('street', t('settings.phone.request.street'))}
        {text('extended', t('settings.phone.request.extended'), { optional: true })}
        <div className="nr-pair nr-pair-postal">
          {text('postal_code', t('settings.phone.request.postalCode'))}
          {text('city', t('settings.phone.request.addressCity'))}
        </div>
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
}

/** The carrier's blank form for the Bundesnetzagentur (Telnyx, help article 1311450 "Germany DID Requirements"). */
const BNETZA_FORM_URL = 'https://github.com/user-attachments/files/32972910/Telnyx.Germany.Registration.Form.pdf'

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
    <fieldset className="nr-group">
      <legend>{t('settings.phone.request.documents.title')}</legend>
      <p className="help nr-hint">{t('settings.phone.request.documents.help')}</p>
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
                  {kind === 'bnetza_form' && (
                    <span className="help">
                      <a href={BNETZA_FORM_URL} target="_blank" rel="noreferrer">
                        {t('settings.phone.request.documents.bnetzaForm.download')}
                      </a>{' '}
                      {t('settings.phone.request.documents.bnetzaForm.hint')}
                    </span>
                  )}
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
