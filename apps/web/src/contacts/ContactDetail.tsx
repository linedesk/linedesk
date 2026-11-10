// The contact's record beside the list: the same editable fields as the call view's side panel, and their calls.
import type { Call } from '@callfront/db/types'
import { Facts, SideCalls } from '../call/CustomerSide.tsx'
import { formatPhone } from '../inbox-model.ts'
import { Avatar, Button } from '../ui/kit.tsx'
import { contactLabel, type ContactRow } from './model.ts'

type Props = { row: ContactRow; toast: (text: string) => void; onOpenCall: (call: Call) => void; onClose: () => void }

export function ContactDetail({ row, toast, onOpenCall, onClose }: Props) {
  const { contact, calls } = row
  const label = contactLabel(contact)
  return (
    <aside className="cv-side cust-side" aria-label="Contact">
      <div className="side-who">
        {contact.name && <Avatar name={contact.name} />}
        <div><b>{label}</b><span>{contact.company ?? (contact.name ? formatPhone(contact.phone) : 'No name yet')}</span></div>
        <Button size="sm" variant="ghost" icon="left" className="side-open" aria-label="Close contact" title="Close (esc)" onClick={onClose} />
      </div>
      <Facts key={contact.id} contact={contact} toast={toast} />
      <div className="side-sec">
        <h2>Calls{calls.length ? ` · ${calls.length}` : ''}</h2>
        <SideCalls calls={calls} onOpen={onOpenCall} />
        {!calls.length && <span className="help">No calls yet.</span>}
      </div>
    </aside>
  )
}
