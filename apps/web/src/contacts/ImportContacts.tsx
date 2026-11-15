// Contacts › Import: a CSV file (first row names the columns) → which column is what → a preview with
// what is new and what fills existing contacts → contact.import, in parts of CONTACT_IMPORT_MAX_ROWS.
// Rows matching a contact by number or email only fill its empty fields; nothing is overwritten.
// Every part is checked before the first is sent, so a bad row never stops an import halfway; importing
// the same file again is safe (rows already imported only fill empty fields).
import { CONTACT_IMPORT_MAX_ROWS, type ContactImportData, contactImport } from '@linedesk/actions'
import { useMemo, useRef, useState } from 'react'
import { formatPhone } from '../inbox-model.ts'
import { CSV_TYPE, saveFile, toCsv } from '../insights/spreadsheet.ts'
import { useWriteAction } from '../settings/settings-api.ts'
import { useDefaultPhoneCountry } from '../phoneCountry.ts'
import { useRows } from '../store.tsx'
import { useWorkspaceCountry } from '../workspaceLocale.ts'
import { Select } from '../ui/controls.tsx'
import { Dialog } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import {
  type ColumnMap,
  type CsvTable,
  decodeCsvFile,
  EXAMPLE_CONTACTS,
  EXAMPLE_FILE_NAME,
  fileSizeProblem,
  guessColumns,
  IMPORT_FIELDS,
  type ImportField,
  type ImportPlan,
  type ImportRow,
  MULTI_COLUMN_FIELDS,
  parseCsv,
  planImport,
  planSummary,
  tableOf,
} from './csvImport.ts'
import { fmt } from '../i18n/format.ts'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'

const FIELD_LABEL = {
  phone: msg('contacts.field.phone'),
  name: msg('contacts.field.name'),
  company: msg('contacts.field.company'),
  email: msg('contacts.field.email'),
  address: msg('contacts.field.address'),
  note: msg('contacts.field.note'),
  skip: msg('contacts.import.skip'),
} satisfies Record<ImportField | 'skip', MessageKey>
const fieldOptions = () =>
  [...IMPORT_FIELDS, 'skip' as const].map(value => ({ value, label: i18n().t(FIELD_LABEL[value]) }))
const PREVIEW_ROWS = 5

type File = CsvTable & { name: string }

/** The import in parts contact.import takes, or the first row it would refuse (checked before anything is sent). */
function importParts(rows: ImportRow[]): { parts: { rows: ImportRow[] }[] } | { problem: string } {
  const parts: { rows: ImportRow[] }[] = []
  for (let i = 0; i < rows.length; i += CONTACT_IMPORT_MAX_ROWS) {
    const part = { rows: rows.slice(i, i + CONTACT_IMPORT_MAX_ROWS) }
    const checked = contactImport.input.safeParse(part)
    if (!checked.success) {
      const issue = checked.error.issues[0]!
      const row = part.rows[issue.path[1] as number]
      return {
        problem: row?.phone
          ? i18n().t('contacts.import.rowRefused', { phone: row.phone, reason: issue.message })
          : i18n().t('contacts.import.rowRefusedNoPhone', { reason: issue.message }),
      }
    }
    parts.push(part)
  }
  return { parts }
}

function importedSummary(total: ContactImportData): string {
  const { t } = i18n()
  const parts = [
    t('contacts.import.planAdded', { count: total.created }),
    t('contacts.import.doneUpdated', { count: total.updated }),
    total.unchanged && t('contacts.import.doneUnchanged', { count: total.unchanged }),
    total.skipped && t('contacts.import.doneSkipped', { count: total.skipped }),
  ].filter((part): part is string => Boolean(part))
  return t('contacts.import.done', { parts: fmt().list(parts) })
}

type Props = { onClose: () => void; toast: (text: string) => void }

export function ImportContacts({ onClose, toast }: Props) {
  const t = useT()
  const write = useWriteAction()
  // Deleted contacts too: contact.import leaves their numbers out, and the preview says so.
  const contacts = useRows('contacts')
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [columns, setColumns] = useState<ColumnMap>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // National numbers are read as the workspace country writes them (the API's resolved country; until it loads, the
  // phone fields' default).
  const fallbackCountry = useDefaultPhoneCountry()
  const country = useWorkspaceCountry()?.country ?? fallbackCountry
  const plan = useMemo(
    () => (file ? planImport(file.data, columns, contacts, undefined, country) : null),
    [file, columns, contacts, country],
  )

  async function read(picked: globalThis.File | undefined) {
    if (!picked) return
    setError(null)
    setFile(null)
    const sizeProblem = fileSizeProblem(picked.size)
    if (sizeProblem) return setError(sizeProblem)
    const decoded = decodeCsvFile(new Uint8Array(await picked.arrayBuffer()))
    if ('problem' in decoded) return setError(decoded.problem)
    const table = tableOf(parseCsv(decoded.text))
    if ('problem' in table) return setError(table.problem)
    setFile({ name: picked.name, ...table })
    setColumns(guessColumns(table.header))
  }

  async function run() {
    if (!plan?.rows.length) return
    const prepared = importParts(plan.rows)
    if ('problem' in prepared) return setError(prepared.problem)
    setError(null)
    setBusy(true)
    const total: ContactImportData = { created: 0, updated: 0, unchanged: 0, skipped: 0 }
    let sent = 0
    try {
      for (const part of prepared.parts) {
        const done = await write<ContactImportData>('contact.import', part)
        for (const key of Object.keys(total) as (keyof ContactImportData)[]) total[key] += done[key]
        sent += part.rows.length
      }
      toast(importedSummary(total))
      onClose()
    } catch (e) {
      const message = (e as Error).message.replace(/([^.!?])$/, '$1.')
      setError(
        sent
          ? t('contacts.import.stopped', { sent, total: plan.rows.length, message })
          : t('contacts.import.nothing', { message }),
      )
      setBusy(false)
    }
  }

  const hasPhone = columns.includes('phone')
  return (
    <Dialog
      title={t('contacts.import.label')}
      description={
        file ? (
          file.name
        ) : (
          <T
            k="contacts.import.description"
            values={{
              example: chunks => (
                <button
                  type="button"
                  className="k-link"
                  title={t('contacts.import.downloadTitle', { file: EXAMPLE_FILE_NAME })}
                  onClick={() => saveFile(EXAMPLE_FILE_NAME, toCsv(EXAMPLE_CONTACTS), CSV_TYPE)}
                >
                  {chunks}
                </button>
              ),
            }}
          />
        )
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          {file ? (
            <Button
              busy={busy}
              variant="primary"
              disabled={busy || !hasPhone || !plan?.rows.length}
              onClick={() => void run()}
            >
              {busy
                ? t('contacts.import.importing')
                : plan
                  ? t('contacts.import.importCount', { count: plan.rows.length })
                  : t('contacts.import.button')}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => input.current?.click()}>
              {t('contacts.import.chooseFile')}
            </Button>
          )}
        </>
      }
    >
      <input
        ref={input}
        type="file"
        accept=".csv,.tsv,.txt,text/csv"
        hidden
        onChange={e => {
          const picked = e.target.files?.[0]
          e.target.value = '' // so picking the same file again (after fixing it) reads it again
          void read(picked).catch(err => setError((err as Error).message))
        }}
      />
      {error && <Note tone="danger">{error}</Note>}
      {file && (
        <>
          <div className="imp-cols">
            {file.header.map((title, col) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the columns of one file never move
              <div key={col} className="imp-col">
                <span className="imp-col-h" title={title}>
                  {title || t('contacts.import.column', { number: col + 1 })}
                </span>
                <Select
                  size="sm"
                  label={t('contacts.import.columnIs', { column: title || String(col + 1) })}
                  value={columns[col] ?? 'skip'}
                  options={fieldOptions()}
                  onChange={field =>
                    setColumns(cs =>
                      cs.map((c, i) =>
                        i === col
                          ? field
                          : c === field && field !== 'skip' && !MULTI_COLUMN_FIELDS.includes(field)
                            ? 'skip'
                            : c,
                      ),
                    )
                  }
                />
                <span className="imp-col-ex">{file.data.find(r => r.some(c => c.trim()))?.[col] ?? ''}</span>
              </div>
            ))}
          </div>
          {!hasPhone ? (
            <p className="help">{t('contacts.import.pickPhone')}</p>
          ) : (
            plan && (
              <>
                <p className="help">{planSummary(plan, country)}</p>
                <table className="imp-preview">
                  <thead>
                    <tr>
                      <th>{t('contacts.field.phone')}</th>
                      <th>{t('contacts.field.name')}</th>
                      <th>{t('contacts.field.company')}</th>
                      <th>{t('contacts.field.email')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.rows.slice(0, PREVIEW_ROWS).map(row => (
                      <tr key={row.phone}>
                        <td>{formatPhone(row.phone)}</td>
                        <td>{row.name}</td>
                        <td>{row.company}</td>
                        <td>{row.email}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )
          )}
        </>
      )}
    </Dialog>
  )
}
