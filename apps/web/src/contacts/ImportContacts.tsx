// Contacts › Import: a CSV file (first row names the columns) → which column is what → a preview with
// what is new and what fills existing contacts → contact.import, in parts of CONTACT_IMPORT_MAX_ROWS.
// Rows matching a contact by number or email only fill its empty fields; nothing is overwritten.
import { CONTACT_IMPORT_MAX_ROWS, type ContactImportData } from '@linedesk/actions'
import type { Contact } from '@linedesk/db/types'
import { useMemo, useRef, useState } from 'react'
import { formatPhone } from '../inbox-model.ts'
import { useWriteAction } from '../settings/settings-api.ts'
import { Select } from '../ui/controls.tsx'
import { Dialog } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { type ColumnMap, guessColumns, IMPORT_FIELDS, type ImportField, parseCsv, planImport } from './csvImport.ts'

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
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

type File = { name: string; header: string[]; data: string[][] }

type Props = { contacts: Iterable<Contact>; onClose: () => void; toast: (text: string) => void }

export function ImportContacts({ contacts, onClose, toast }: Props) {
  const write = useWriteAction()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [columns, setColumns] = useState<ColumnMap>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const plan = useMemo(() => (file ? planImport(file.data, columns, contacts) : null), [file, columns, contacts])

  async function read(picked: globalThis.File | undefined) {
    if (!picked) return
    setError(null)
    const rows = parseCsv(await picked.text())
    if (rows.length < 2) return setError('The file has no rows under its first line. The first row names the columns.')
    const [header, ...data] = rows
    setFile({ name: picked.name, header: header!, data })
    setColumns(guessColumns(header!))
  }

  async function run() {
    if (!plan?.rows.length) return
    setBusy(true)
    const total: ContactImportData = { created: 0, updated: 0, unchanged: 0, skipped: 0 }
    try {
      for (let i = 0; i < plan.rows.length; i += CONTACT_IMPORT_MAX_ROWS) {
        const part = await write<ContactImportData>('contact.import', {
          rows: plan.rows.slice(i, i + CONTACT_IMPORT_MAX_ROWS),
        })
        for (const key of Object.keys(total) as (keyof ContactImportData)[]) total[key] += part[key]
      }
      toast(`Imported: ${plural(total.created, 'new contact')}, ${total.updated} updated.`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const hasPhone = columns.includes('phone')
  return (
    <Dialog
      title="Import contacts"
      description={file ? file.name : 'A CSV file; its first row names the columns.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {file ? (
            <Button variant="primary" disabled={busy || !hasPhone || !plan?.rows.length} onClick={() => void run()}>
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
        accept=".csv,text/csv"
        hidden
        onChange={e => void read(e.target.files?.[0]).catch(err => setError((err as Error).message))}
      />
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
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
                      cs.map((c, i) => (i === col ? field : c === field && field !== 'skip' ? 'skip' : c)),
                    )
                  }
                />
                <span className="imp-col-ex">{file.data[0]?.[col] ?? ''}</span>
              </div>
            ))}
          </div>
          {!hasPhone ? (
            <p className="help">Pick the column with the phone number.</p>
          ) : (
            plan && (
              <>
                <p className="help">
                  {plural(plan.added, 'new contact')} · {plan.matched} fill empty fields of existing contacts
                  {plan.repeated ? ` · ${plural(plan.repeated, 'repeated number')} combined` : ''}
                  {plan.unreadable.length
                    ? ` · ${plural(plan.unreadable.length, 'row')} without a readable number (${plan.unreadable.slice(0, 5).join(', ')}${plan.unreadable.length > 5 ? ', …' : ''}) left out`
                    : ''}
                </p>
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
