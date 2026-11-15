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

const FIELD_LABEL: Record<ImportField | 'skip', string> = {
  phone: 'Phone',
  name: 'Name',
  company: 'Company',
  email: 'Email',
  address: 'Address',
  note: 'Note',
  skip: 'Skip',
}
const fieldOptions = [...IMPORT_FIELDS, 'skip' as const].map(value => ({ value, label: FIELD_LABEL[value] }))
const PREVIEW_ROWS = 5
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

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
        problem: `Nothing was imported: the row for ${row?.phone ?? 'a contact'} cannot be saved (${issue.message}).`,
      }
    }
    parts.push(part)
  }
  return { parts }
}

function importedSummary(total: ContactImportData): string {
  return `Imported: ${[
    plural(total.created, 'new contact'),
    `${total.updated.toLocaleString('en-US')} updated`,
    total.unchanged && `${total.unchanged.toLocaleString('en-US')} already up to date`,
    total.skipped && `${total.skipped.toLocaleString('en-US')} of deleted contacts left out`,
  ]
    .filter(Boolean)
    .join(', ')}.`
}

type Props = { onClose: () => void; toast: (text: string) => void }

export function ImportContacts({ onClose, toast }: Props) {
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
          ? `The import stopped after ${sent.toLocaleString('en-US')} of ${plan.rows.length.toLocaleString('en-US')} rows: ${message} Import the file again to add the rest; rows already imported are not added twice.`
          : `Nothing was imported: ${message}`,
      )
      setBusy(false)
    }
  }

  const hasPhone = columns.includes('phone')
  return (
    <Dialog
      title="Import contacts"
      description={
        file ? (
          file.name
        ) : (
          <>
            A CSV file; its first row names the columns.{' '}
            <button
              type="button"
              className="k-link"
              title={`Download ${EXAMPLE_FILE_NAME}`}
              onClick={() => saveFile(EXAMPLE_FILE_NAME, toCsv(EXAMPLE_CONTACTS), CSV_TYPE)}
            >
              Download an example
            </button>
            .
          </>
        )
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {file ? (
            <Button
              busy={busy}
              variant="primary"
              disabled={busy || !hasPhone || !plan?.rows.length}
              onClick={() => void run()}
            >
              {busy ? 'Importing…' : `Import ${plan ? plan.rows.length : ''}`}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => input.current?.click()}>
              Choose file
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
                  {title || `Column ${col + 1}`}
                </span>
                <Select
                  size="sm"
                  label={`Column ${title || col + 1} is`}
                  value={columns[col] ?? 'skip'}
                  options={fieldOptions}
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
            <p className="help">Pick the column with the phone number.</p>
          ) : (
            plan && (
              <>
                <p className="help">{planSummary(plan, country)}</p>
                <table className="imp-preview">
                  <thead>
                    <tr>
                      <th>Phone</th>
                      <th>Name</th>
                      <th>Company</th>
                      <th>Email</th>
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
