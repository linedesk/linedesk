import type { Call, Contact } from '@linedesk/db/types'
import { callTitle, formatPhone, isTestCall, testCallLabel } from '../inbox-model.ts'
import { useContact, useRows, useRun } from '../store.tsx'
import { parseTs, callDuration, timeLabel } from '../time.ts'
import { Avatar, Badge, Button, Icon } from '../ui/kit.tsx'
import { EditableFact } from './EditableFact.tsx'
import { EmailedAfterCall } from './EmailedAfterCall.tsx'
import { T, useT } from '@linedesk/i18n/react'
import { LinkButton } from '../ui/AppLink.tsx'
import { i18n } from '../i18n/index.tsx'

type Props = {
  call: Call
  onOpen: (call: Call) => void
  toast: (text: string) => void
  onToggleBlock?: (call: Call) => void
}
type Editable = 'name' | 'company' | 'email' | 'address' | 'note'

function copy(text: string, toast: (text: string) => void) {
  navigator.clipboard.writeText(text).then(
    () => toast(i18n().t('call.contact.copied', { text })),
    () => toast(i18n().t('call.contact.copyFailed')),
  )
}

/** Whether the contact's name is only what a caller said (contacts.name_source): it checks nobody on the phone. */
export const nameFromCaller = (contact: Contact) => !!contact.name?.trim() && contact.name_source !== 'member'

/**
 * "Name from caller · Confirm": a member confirms the name (contact.update saves it as the team's), so the
 * assistant may talk about earlier calls once a caller says it. Also used on the Contacts page.
 */
export function ConfirmCallerName({ contact }: { contact: Contact }) {
  const t = useT()
  const run = useRun()
  return (
    <T
      k="call.contact.nameFromCaller"
      values={{
        confirm: chunks => (
          <LinkButton
            title={t('call.contact.confirmTitle')}
            onClick={() => void run('contact.update', { contactId: contact.id, name: contact.name })}
          >
            {chunks}
          </LinkButton>
        ),
      }}
    />
  )
}

/** The contact's fields, edited in place through contact.update. Also used on the Contacts page. */
export function Facts({ contact, toast }: { contact: Contact; toast: (text: string) => void }) {
  const t = useT()
  const run = useRun()
  const save = (field: Editable) => (value: string | null) =>
    void run('contact.update', { contactId: contact.id, [field]: value })
  const phone = formatPhone(contact.phone)
  return (
    <dl className="facts side-facts">
      <EditableFact
        field="name"
        label={t('call.contact.name')}
        value={contact.name}
        placeholder={t('call.contact.addName')}
        onSave={save('name')}
      />
      {nameFromCaller(contact) && (
        <dd className="fact-hint">
          <ConfirmCallerName contact={contact} />
        </dd>
      )}
      <EditableFact
        field="company"
        label={t('call.contact.company')}
        value={contact.company}
        placeholder={t('call.contact.addCompany')}
        onSave={save('company')}
      />
      <dt>{t('call.contact.phone')}</dt>
      <dd>
        <button type="button" className="fact-copy" title={t('call.contact.copy')} onClick={() => copy(phone, toast)}>
          {phone}
        </button>
      </dd>
      <EditableFact
        field="email"
        label={t('call.contact.email')}
        value={contact.email}
        placeholder={t('call.contact.addEmail')}
        onSave={save('email')}
      />
      <EditableFact
        field="address"
        label={t('call.contact.address')}
        value={contact.address}
        placeholder={t('call.contact.addAddress')}
        onSave={save('address')}
      />
      <EditableFact
        field="note"
        label={t('call.contact.note')}
        value={contact.note}
        placeholder={t('call.contact.addNote')}
        onSave={save('note')}
        multiline
      />
    </dl>
  )
}

/** Call the number from this device (a phone, or a computer that hands tel: links to one). */
export function CallLink({ number }: { number: string }) {
  const t = useT()
  return (
    <a className="k-btn k-btn-secondary k-btn-sm" href={`tel:${number}`} title={t('call.contact.callFromPhone')}>
      <Icon name="phone-out" size={14} />
      <span>{t('call.contact.call')}</span>
    </a>
  )
}

/** A compact list of calls that open the call view. Also used on the Contacts page. */
export function SideCalls({ calls, onOpen }: { calls: Call[]; onOpen: (call: Call) => void }) {
  const t = useT()
  return calls.map(c => (
    <button key={c.id} type="button" className="side-call" onClick={() => onOpen(c)}>
      <span className="sc-top">
        <b>{callTitle(c)}</b>
        <span className="mono">{timeLabel(parseTs(c.started_at))}</span>
      </span>
      <span className="sc-sub">
        {t('call.contact.sideCall', {
          direction: c.direction === 'out' ? t('call.contact.outbound') : t('call.contact.inbound'),
          length: c.status === 'live' ? t('call.contact.live') : c.duration_sec ? callDuration(c.duration_sec) : '—',
        })}
      </span>
    </button>
  ))
}

function PastCalls({ call, onOpen }: Pick<Props, 'call' | 'onOpen'>) {
  const t = useT()
  const others = useRows('calls')
    .filter(
      c =>
        c.id !== call.id &&
        !c.deleted_at &&
        (call.contact_id ? c.contact_id === call.contact_id : c.from_number === call.from_number),
    )
    .filter(c => parseTs(c.started_at) < parseTs(call.started_at)) // earlier calls only
    .sort((a, b) => parseTs(b.started_at).getTime() - parseTs(a.started_at).getTime())
  return (
    <div className="side-sec">
      <h2>{t('call.contact.previousCalls')}</h2>
      <SideCalls calls={others} onOpen={onOpen} />
      {!others.length && <span className="help">{t('call.contact.noEarlierCalls')}</span>}
    </div>
  )
}

/** The caller next to the call: who they are (editable) and what they called about before. */
export function ContactSide({ call, onOpen, toast, onToggleBlock }: Props) {
  const t = useT()
  const linked = useContact(call.contact_id)
  const contact = linked?.deleted_at ? undefined : linked // a deleted contact reads as an unknown caller
  const name = isTestCall(call) ? testCallLabel() : contact?.name
  return (
    <aside className="cv-side" aria-label={t('call.contact.label')}>
      <div className="side-who">
        <Avatar name={name ?? '?'} />
        <div>
          <b>{name ?? t('call.contact.unknownCaller')}</b>
          <span>{contact?.company ?? formatPhone(call.from_number)}</span>
        </div>
      </div>
      <div className="side-acts">
        {call.from_number.startsWith('+') && <CallLink number={call.from_number} />}
        {contact && onToggleBlock && (
          <Button
            size="sm"
            variant="ghost"
            title={t('common.withKey', {
              label: contact.blocked_at ? t('call.contact.unblockNumber') : t('call.contact.blockNumber'),
              key: '⇧B',
            })}
            onClick={() => onToggleBlock(call)}
          >
            {contact.blocked_at ? t('call.contact.unblock') : t('call.contact.block')}
          </Button>
        )}
        {contact?.blocked_at && <Badge>{t('call.contact.blocked')}</Badge>}
        {call.spam_likely && <Badge title={t('call.contact.spamLikelyTitle')}>{t('call.contact.spamLikely')}</Badge>}
        {call.caller_attestation && call.caller_attestation !== 'A' && (
          <Badge title={t('call.contact.notVerifiedTitle')}>{t('call.contact.notVerified')}</Badge>
        )}
      </div>
      {contact ? (
        <Facts contact={contact} toast={toast} />
      ) : (
        <span className="help">{t('call.contact.notLinked')}</span>
      )}
      <EmailedAfterCall call={call} />
      <PastCalls call={call} onOpen={onOpen} />
    </aside>
  )
}
