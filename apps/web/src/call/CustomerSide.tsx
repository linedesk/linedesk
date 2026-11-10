import type { Call, Contact } from '@callfront/db/types'
import { callTitle, formatPhone } from '../inbox-model.ts'
import { useContact, useRows, useRun } from '../store.tsx'
import { parseTs, shortDuration, timeLabel } from '../time.ts'
import { Avatar } from '../ui/kit.tsx'
import { EditableFact } from './EditableFact.tsx'

type Props = { call: Call; onOpen: (call: Call) => void; toast: (text: string) => void }
type Editable = 'name' | 'company' | 'email' | 'address' | 'note'

function copy(text: string, toast: (text: string) => void) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${text}`), () => toast('Copy failed. Select the number instead.'))
}

/** The contact's fields, edited in place through contact.update. Also used on the Contacts page. */
export function Facts({ contact, toast }: { contact: Contact; toast: (text: string) => void }) {
  const run = useRun()
  const save = (field: Editable) => (value: string | null) => void run('contact.update', { contactId: contact.id, [field]: value })
  const phone = formatPhone(contact.phone)
  return (
    <dl className="facts side-facts">
      <EditableFact label="Name" value={contact.name} placeholder="Add name" onSave={save('name')} />
      <EditableFact label="Company" value={contact.company} placeholder="Add company" onSave={save('company')} />
      <dt>Phone</dt>
      <dd><button type="button" className="fact-copy" title="Copy" onClick={() => copy(phone, toast)}>{phone}</button></dd>
      <EditableFact label="Email" value={contact.email} placeholder="Add email" onSave={save('email')} />
      <EditableFact label="Address" value={contact.address} placeholder="Add address" onSave={save('address')} />
      <EditableFact label="Note" value={contact.note} placeholder="Add a note" onSave={save('note')} multiline />
    </dl>
  )
}

/** A compact list of calls that open the call view. Also used on the Contacts page. */
export function SideCalls({ calls, onOpen }: { calls: Call[]; onOpen: (call: Call) => void }) {
  return calls.map(c => (
    <button key={c.id} type="button" className="side-call" onClick={() => onOpen(c)}>
      <span className="sc-top"><b>{callTitle(c)}</b><span className="mono">{timeLabel(parseTs(c.started_at))}</span></span>
      <span className="sc-sub">{c.direction === 'out' ? 'Outbound' : 'Inbound'} · {c.status === 'live' ? 'live' : c.duration_sec ? shortDuration(c.duration_sec) : '—'}</span>
    </button>
  ))
}

function PastCalls({ call, onOpen }: Pick<Props, 'call' | 'onOpen'>) {
  const others = useRows('calls')
    .filter(c => c.id !== call.id && !c.deleted_at && (call.contact_id ? c.contact_id === call.contact_id : c.from_number === call.from_number))
    .filter(c => parseTs(c.started_at) < parseTs(call.started_at)) // earlier calls only
    .sort((a, b) => parseTs(b.started_at).getTime() - parseTs(a.started_at).getTime())
  return (
    <div className="side-sec">
      <h2>Previous calls</h2>
      <SideCalls calls={others} onOpen={onOpen} />
      {!others.length && <span className="help">No earlier calls.</span>}
    </div>
  )
}

/** The caller next to the call: who they are (editable) and what they called about before. */
export function CustomerSide({ call, onOpen, toast }: Props) {
  const contact = useContact(call.contact_id)
  return (
    <aside className="cv-side" aria-label="Caller">
      <div className="side-who">
        <Avatar name={contact?.name ?? '?'} />
        <div><b>{contact?.name ?? 'Unknown caller'}</b><span>{contact?.company ?? formatPhone(call.from_number)}</span></div>
      </div>
      {contact ? <Facts contact={contact} toast={toast} /> : <span className="help">This number is not linked to a contact.</span>}
      <PastCalls call={call} onOpen={onOpen} />
    </aside>
  )
}
