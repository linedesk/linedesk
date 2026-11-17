// Settings › Assistant › Call emails (LIN-369): one instruction in the owner's words that says who gets the email
// about which call, people named with @ (members and confirmed outside addresses). After a call a language model
// picks the recipients among the people named (apps/api/src/email-routing.ts). The text is part of the assistant's
// draft and saved with the page; the editor shows `@Name` and keeps tokens in the draft (callEmailsModel.ts).
// Next to it the instruction tried on the assistant's last calls (assistant.previewEmailRouting), and the list of
// outside addresses with their confirmation state (emailRouting.get, emailRecipient.*).
import {
  assigneeOf,
  EMAIL_ROUTING_CODES,
  EMAIL_ROUTING_MAX,
  type EmailRoutingData,
  type EmailRoutingPreview,
  type EmailRoutingPreviewCall,
  type OutsideRecipient,
  type OutsideRecipientStatus,
  OUTSIDE_CONFIRMS_PER_DAY,
  OUTSIDE_RECIPIENTS_MAX,
  OUTSIDE_STOP_COOLDOWN_DAYS,
  routesEmails,
} from '@linedesk/actions'
import type { EmailRouteRecipient } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type Query, setQueryData, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { memberAvatar, memberLabel, useMembers } from '../team/members.ts'
import { parseTs, timeLabel } from '../time.ts'
import { Avatar, Badge, Button, cx, Icon, Note } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Loading, Skeleton, useLoadState } from '../ui/LoadStates.tsx'
import {
  insertMention,
  matchPeople,
  type MentionPerson,
  mentionedPeople,
  mentionPeople,
  mentionQuery,
  offersToAdd,
  pieces,
  toCanonical,
  toDisplay,
} from './callEmailsModel.ts'
import { Field, Section } from './fields.tsx'
import { MissingProviderNote } from './MissingProviderNote.tsx'
import { callAction, readAction } from './settings-api.ts'
import './call-emails.css'

/** How long after the last keystroke the instruction is tried on the last calls. */
const PREVIEW_AFTER_MS = 2500
const ROUTING_KEY = 'emailRouting.get'
const loadRouting = () => readAction<EmailRoutingData>(ROUTING_KEY)
const CHECK_KEY = '⌘↵'

/** Revert a change from a toast's Undo (Workspace's undo stack, also Z). */
export type Undoable = (label: string, key: string, revert: () => void) => void

type Props = {
  assistantId: string
  /** The assistant's name as the page says it. */
  name: string
  value: string
  onChange: (value: string) => void
  /** Members who get the call assigned too, when it is emailed to them (user ids). */
  assign: string[]
  onAssignChange: (ids: string[]) => void
  canEdit: boolean
  toast: (text: string) => void
  undoable?: Undoable
}

/** A rejection the page words itself (EMAIL_ROUTING_CODES), else the server's own text. */
// i18n-dynamic: settings.assistant.emails.error.*
function errorText(err: unknown): string {
  const code = (err as { code?: string }).code
  return code && (EMAIL_ROUTING_CODES as readonly string[]).includes(code)
    ? i18n().t(`settings.assistant.emails.error.${code}` as MessageKey, {
        max: OUTSIDE_RECIPIENTS_MAX,
        days: OUTSIDE_STOP_COOLDOWN_DAYS,
        perDay: OUTSIDE_CONFIRMS_PER_DAY,
      })
    : (err as Error).message
}

export function CallEmails({
  assistantId,
  name,
  value,
  onChange,
  assign,
  onAssignChange,
  canEdit,
  toast,
  undoable,
}: Props) {
  const t = useT()
  const format = useFormat()
  const members = useMembers()
  const membersState = useLoadState('workspace_members')
  const routing = useQuery<EmailRoutingData>(canEdit ? ROUTING_KEY : null, loadRouting)
  const data = routing.data
  const people = useMemo(
    () =>
      mentionPeople(
        members.map(m => {
          const known = data?.members.find(d => d.userId === m.user_id)
          return {
            userId: m.user_id,
            name: memberLabel(m),
            email: known?.email,
            emailOn: known?.emailOn,
            disabled: m.disabled,
          }
        }),
        data?.recipients.map(r => r.email) ?? [],
        value,
        memberLabel(undefined),
      ),
    [members, data, value],
  )
  const mentioned = mentionedPeople(value, people)
  const mentionedMembers = mentioned.filter(p => p.kind === 'user')
  // Only members still named: what would be saved.
  const assigned = assign.filter(id => mentionedMembers.some(p => p.id === id))
  const preview = usePreview(assistantId, value, canEdit)
  const outsideNamed = mentioned.filter(p => p.kind === 'email')
  const emailsOff = mentioned.filter(p => p.kind === 'user' && p.emailOn === false)
  const tooLong = value.length > EMAIL_ROUTING_MAX

  async function addOutside(email: string): Promise<boolean> {
    try {
      const { recipient } = await callAction<{ recipient: OutsideRecipient }>('emailRecipient.add', { email })
      setQueryData<EmailRoutingData | undefined>(ROUTING_KEY, d =>
        d ? { ...d, recipients: [...d.recipients.filter(r => r.id !== recipient.id), recipient] } : d,
      )
      toast(t('settings.assistant.emails.outside.added', { email }))
      return true
    } catch (err) {
      toast(errorText(err))
      return false
    }
  }

  return (
    <>
      <div className={cx('ce-grid', !canEdit && 'is-single')}>
        <Section
          id="as-emails"
          title={t('settings.assistant.emails.who.title')}
          description={t('settings.assistant.emails.who.description', { name })}
          help={t('settings.assistant.emails.who.help', { name })}
        >
          <Field
            id="as-emails-text"
            label={t('settings.assistant.emails.who.label')}
            error={tooLong ? t('settings.assistant.emails.who.tooLong', { max: EMAIL_ROUTING_MAX }) : null}
          >
            <Loading
              what={t('settings.assistant.emails.who.load')}
              loading={membersState === 'loading'}
              error={membersState === 'slow'}
              skeleton={<Skeleton width="100%" height={112} />}
            >
              <MentionEditor
                id="as-emails-text"
                value={value}
                onChange={onChange}
                people={people}
                disabled={!canEdit}
                onAdd={canEdit ? addOutside : undefined}
                onCheck={preview.checkNow}
                placeholder={t('settings.assistant.emails.who.placeholder')}
              />
            </Loading>
          </Field>
          {routesEmails(value) ? (
            mentioned.length ? (
              <>
                <MayEmail name={name} people={mentioned} recipients={data?.recipients} />
                {mentionedMembers.length > 0 && (
                  <AssignChoice
                    name={name}
                    people={mentionedMembers}
                    assigned={assigned}
                    disabled={!canEdit}
                    onChange={onAssignChange}
                  />
                )}
              </>
            ) : (
              <p className="help">{t('settings.assistant.emails.who.nobodyNamed')}</p>
            )
          ) : (
            <p className="help">{t('settings.assistant.emails.who.empty')}</p>
          )}
          {emailsOff.length > 0 && (
            <p className="help">
              {t('settings.assistant.emails.who.emailsOff', {
                count: emailsOff.length,
                names: format.list(emailsOff.map(p => p.label)),
              })}
            </p>
          )}
          {outsideNamed.length > 0 && (
            <Note tone="warning" title={t('settings.assistant.emails.outsideNote.title')}>
              {t('settings.assistant.emails.outsideNote.text', {
                count: outsideNamed.length,
                emails: format.list(outsideNamed.map(p => p.label)),
              })}
            </Note>
          )}
          {data && !data.llm && routesEmails(value) && <MissingProviderNote kind="emailRouting" />}
        </Section>
        {canEdit && <PreviewCard preview={preview} name={name} assign={assigned} />}
      </div>
      {canEdit && <OutsideList routing={routing} toast={toast} undoable={undoable} />}
    </>
  )
}

/** "Maya may email:" and everyone the instruction names, outside addresses with their state. */
function MayEmail({
  name,
  people,
  recipients,
}: {
  name: string
  people: MentionPerson[]
  recipients: OutsideRecipient[] | undefined
}) {
  const t = useT()
  const members = useMembers()
  return (
    <div className="ce-may">
      <span className="ce-may-label">{t('settings.assistant.emails.may', { name })}</span>
      {people.map(p =>
        p.kind === 'user' ? (
          <span key={p.id} className="ce-chip">
            <Avatar name={p.label} size={20} src={memberAvatar(members.find(m => m.user_id === p.id))} />
            {p.label}
            {p.emailOn === false && (
              <span className="ce-chip-note">{t('settings.assistant.emails.chip.emailsOff')}</span>
            )}
          </span>
        ) : (
          <OutsideChip key={p.email} email={p.email} status={recipients?.find(r => r.email === p.email)?.status} />
        ),
      )}
    </div>
  )
}

/**
 * "Also assign the call to:": a toggle per member the instruction names. The code assigns, never the model: the first
 * of them in the instruction's order that gets the email, while nobody has the call yet.
 */
function AssignChoice({
  name,
  people,
  assigned,
  disabled,
  onChange,
}: {
  name: string
  people: MentionPerson[]
  assigned: string[]
  disabled: boolean
  onChange: (ids: string[]) => void
}) {
  const t = useT()
  return (
    <div className="ce-assign">
      <div className="ce-may">
        <span className="ce-may-label">{t('settings.assistant.emails.assign.label')}</span>
        {people.map(p => {
          if (p.kind !== 'user') return null
          const on = assigned.includes(p.id)
          return (
            <button
              key={p.id}
              type="button"
              className="ce-toggle"
              aria-pressed={on}
              disabled={disabled}
              title={t(on ? 'settings.assistant.emails.assign.off' : 'settings.assistant.emails.assign.on', {
                member: p.label,
              })}
              onClick={() => onChange(on ? assigned.filter(id => id !== p.id) : [...assigned, p.id])}
            >
              {on && <Icon name="check" size={12} />}
              {p.label}
            </button>
          )
        })}
      </div>
      <p className="help">{t('settings.assistant.emails.assign.help', { name })}</p>
    </div>
  )
}

const STATUS_TEXT: Record<OutsideRecipientStatus, MessageKey> = {
  waiting: msg('settings.assistant.emails.status.waiting'),
  confirmed: msg('settings.assistant.emails.status.confirmed'),
  stopped: msg('settings.assistant.emails.status.stopped'),
  expired: msg('settings.assistant.emails.status.expired'),
}

/** An outside address: dashed, with its state when it is known (owners and admins). */
function OutsideChip({ email, status }: { email: string; status?: OutsideRecipientStatus }) {
  const t = useT()
  return (
    <span className="ce-chip ce-chip-outside">
      {email}
      {status && <span className="ce-chip-note">{t(STATUS_TEXT[status])}</span>}
    </span>
  )
}

type EditorOption = { kind: 'person'; person: MentionPerson } | { kind: 'add'; email: string }

/**
 * A text area with a highlight layer behind it (same font, padding and wrapping) that marks mentions: members as quiet
 * grey chips, outside addresses dashed. Typing @ opens the people to pick (↑↓, Enter or Tab, Esc); an address that is
 * not on the list can be added from there. ⌘↵ tries the text on the last calls now.
 */
function MentionEditor({
  id,
  value,
  onChange,
  people,
  disabled,
  onAdd,
  onCheck,
  placeholder,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  people: MentionPerson[]
  disabled: boolean
  onAdd?: (email: string) => Promise<boolean>
  onCheck: () => void
  placeholder: string
}) {
  const t = useT()
  const listId = useId()
  const area = useRef<HTMLTextAreaElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const nextCaret = useRef<number | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const display = toDisplay(value, people)
  const typing = caret === null ? null : mentionQuery(display, caret, people)
  const open = typing && typing.at !== dismissed ? typing : null
  const options: EditorOption[] = open
    ? [
        ...matchPeople(open.query, people).map(person => ({ kind: 'person' as const, person })),
        ...(onAdd && offersToAdd(open.query, people)
          ? [{ kind: 'add' as const, email: open.query.trim().toLowerCase() }]
          : []),
      ]
    : []
  const shown = !!open && options.length > 0

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the first option
  useEffect(() => setActive(0), [open?.at, open?.query])
  const notTyping = typing === null
  useEffect(() => {
    if (notTyping) setDismissed(null)
  }, [notTyping])
  // The text area grows with its text, so the highlight layer never has to follow a scroll; a picked mention puts the
  // caret after itself.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the shown text changed, which it measures
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
    if (nextCaret.current !== null && document.activeElement === el) {
      el.setSelectionRange(nextCaret.current, nextCaret.current)
      setCaret(nextCaret.current)
    }
    nextCaret.current = null
  }, [display])

  const readCaret = () => setCaret(area.current?.selectionStart ?? null)

  function put(text: string, at: number, list = people) {
    nextCaret.current = at
    onChange(toCanonical(text, list))
  }

  async function pick(option: EditorOption) {
    if (!open || caret === null) return
    const { at } = open
    const end = caret
    if (option.kind === 'person') {
      const { text, caret: after } = insertMention(display, at, end, option.person)
      return put(text, after)
    }
    const person: MentionPerson = { kind: 'email', email: option.email, label: option.email }
    setDismissed(at)
    if (!(await onAdd!(option.email))) return
    const { text, caret: after } = insertMention(display, at, end, person)
    put(text, after, [...people, person])
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      // ⌘↵ tries the text on the last calls; ⌘S still saves the page.
      e.preventDefault()
      e.stopPropagation()
      return onCheck()
    }
    if (!shown) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive(i => (i + step + options.length) % options.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      void pick(options[active] ?? options[0]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setDismissed(open!.at)
    }
  }

  return (
    <div className={cx('ce-editor', disabled && 'is-disabled')}>
      <div ref={backdrop} className="ta ce-backdrop" aria-hidden="true">
        {pieces(display, people).map((p, i) =>
          p.mention ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are the text in order
            <mark key={i} className={cx('ce-m', `ce-m-${p.mention.kind}`)}>
              {p.text}
            </mark>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are the text in order
            <span key={i}>{p.text}</span>
          ),
        )}
        {/* A last empty line still takes its height. */}{' '}
      </div>
      <textarea
        ref={area}
        id={id}
        className="ta ce-input"
        rows={4}
        value={display}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck
        role="combobox"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={shown ? `${listId}-${active}` : undefined}
        onChange={e => {
          nextCaret.current = null
          setCaret(e.target.selectionStart)
          onChange(toCanonical(e.target.value, people))
        }}
        onSelect={readCaret}
        onClick={readCaret}
        onFocus={readCaret}
        onBlur={() => setCaret(null)}
        onScroll={e => {
          if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop
        }}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <div id={listId} role="listbox" aria-label={t('settings.assistant.emails.menu')} className="k-menu ce-menu">
          {options.map((o, i) => (
            <div
              key={o.kind === 'add' ? `add:${o.email}` : o.person.kind === 'user' ? o.person.id : o.person.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cx('k-select-opt', i === active && 'active')}
              // Keeps the focus (and the caret) in the text area.
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => void pick(o)}
            >
              <OptionLabel option={o} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OptionLabel({ option }: { option: EditorOption }) {
  const t = useT()
  const members = useMembers()
  if (option.kind === 'add')
    return <span className="ce-opt">{t('settings.assistant.emails.addOutside', { email: option.email })}</span>
  const p = option.person
  return p.kind === 'user' ? (
    <>
      <span className="ce-opt">
        <Avatar name={p.label} size={20} src={memberAvatar(members.find(m => m.user_id === p.id))} />
        {p.label}
      </span>
      {p.email && <span className="k-ssel-meta">{p.email}</span>}
    </>
  ) : (
    <>
      <span className="ce-opt">{p.label}</span>
      <span className="k-ssel-meta">{t('settings.assistant.emails.outsideMeta')}</span>
    </>
  )
}

type Preview = {
  /** The text the shown result is for. */
  checked: string
  data: EmailRoutingPreview | undefined
  error: string | null
  /** A result for an earlier text is shown while the new one loads. */
  stale: boolean
  checkNow: () => void
}

/**
 * The instruction tried on the last calls: when the page opens, PREVIEW_AFTER_MS after the text stops changing, and
 * at once on ⌘↵. Each text is asked once (the server allows about 30 an hour per workspace).
 */
function usePreview(assistantId: string, text: string, enabled: boolean): Preview {
  const [checked, setChecked] = useState(text)
  useEffect(() => {
    if (text === checked) return
    const timer = setTimeout(() => setChecked(text), PREVIEW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [text, checked])
  const key = enabled && routesEmails(checked) ? `emailRouting.preview:${assistantId}:${checked}` : null
  const query = useQuery<EmailRoutingPreview>(
    key,
    async () => {
      try {
        return await callAction<EmailRoutingPreview>('assistant.previewEmailRouting', { assistantId, text: checked })
      } catch (err) {
        throw new Error(errorText(err))
      }
    },
    { freshMs: 10 * 60_000 },
  )
  const last = useRef<EmailRoutingPreview | undefined>(undefined)
  if (query.data) last.current = query.data
  return {
    checked,
    data: query.data ?? last.current,
    error: query.error,
    stale: !query.data && !!last.current,
    checkNow: () => (text === checked ? void query.reload() : setChecked(text)),
  }
}

const PROBLEM_TEXT: Record<NonNullable<EmailRoutingPreviewCall['problem']>, MessageKey> = {
  no_llm: msg('settings.assistant.emails.preview.problem.no_llm'),
  llm_failed: msg('settings.assistant.emails.preview.problem.llm_failed'),
  nothing_fit: msg('settings.assistant.emails.preview.problem.nothing_fit'),
}

/** "On your last calls": per call who it would go to, whom it would assign and why. */
function PreviewCard({ preview, name, assign }: { preview: Preview; name: string; assign: string[] }) {
  const t = useT()
  const routes = routesEmails(preview.checked)
  return (
    <Section
      id="as-emails-preview"
      title={t('settings.assistant.emails.preview.title')}
      description={t('settings.assistant.emails.preview.description')}
      actions={
        routes && (
          <Button
            size="sm"
            variant="ghost"
            title={t('common.withKey', { label: t('settings.assistant.emails.preview.checkTitle'), key: CHECK_KEY })}
            onClick={preview.checkNow}
          >
            {t('settings.assistant.emails.preview.check')}
          </Button>
        )
      }
    >
      {!routes ? (
        <p className="help">{t('settings.assistant.emails.preview.empty')}</p>
      ) : preview.error ? (
        <Note tone="warning" title={t('settings.assistant.emails.preview.failed')}>
          {preview.error}
        </Note>
      ) : (
        <Loading
          what={t('settings.assistant.emails.preview.load')}
          loading={!preview.data}
          skeleton={<PreviewSkeleton />}
        >
          {preview.data && !preview.data.calls.length ? (
            <ListEmpty>{t('settings.assistant.emails.preview.noCalls', { name })}</ListEmpty>
          ) : (
            <ul className={cx('ce-calls', preview.stale && 'is-stale')} aria-busy={preview.stale || undefined}>
              {preview.data?.calls.map(c => (
                <PreviewLine
                  key={c.callId}
                  call={c}
                  name={name}
                  assignee={assigneeOf(
                    preview.checked,
                    assign,
                    c.to.flatMap(r => (r.kind === 'member' ? [r.user_id] : [])),
                  )}
                />
              ))}
            </ul>
          )}
        </Loading>
      )}
    </Section>
  )
}

/**
 * One call of the preview. Who gets it assigned is worked out here from the Assign choice on the page (the same rule
 * the server uses), so a new choice shows at once and asks the model nothing.
 */
function PreviewLine({
  call,
  name,
  assignee,
}: {
  call: EmailRoutingPreviewCall
  name: string
  assignee: string | null
}) {
  const t = useT()
  const assigned = call.to.find(r => r.kind === 'member' && r.user_id === assignee)
  return (
    <li className="ce-call">
      <div className="ce-call-head">
        <b>{call.title?.trim() || t('settings.assistant.emails.preview.untitled')}</b>
        <span className="mono">{timeLabel(parseTs(call.started_at))}</span>
      </div>
      {/* A fallback line lists who would really get it (every member with call emails on), then the reason below. */}
      <RecipientChips to={call.to} />
      {!call.to.length && <p className="help">{t('settings.assistant.emails.preview.nobody')}</p>}
      {call.reason && <p className="ce-call-reason">{call.reason}</p>}
      {assigned?.kind === 'member' && (
        <p className="help">{t('settings.assistant.emails.preview.assigns', { member: assigned.name, name })}</p>
      )}
      {call.problem && <p className="help">{t(PROBLEM_TEXT[call.problem])}</p>}
    </li>
  )
}

/** The people a call email went (or would go) to: members with their picture, outside addresses dashed. */
export function RecipientChips({ to }: { to: EmailRouteRecipient[] }) {
  const members = useMembers()
  if (!to.length) return null
  return (
    <div className="ce-chips">
      {to.map(r =>
        r.kind === 'member' ? (
          <span key={r.user_id} className="ce-chip">
            <Avatar name={r.name} size={20} src={memberAvatar(members.find(m => m.user_id === r.user_id))} />
            {r.name}
          </span>
        ) : (
          <OutsideChip key={r.email} email={r.email} />
        ),
      )}
    </div>
  )
}

/** The preview's rows while the first answer loads: a title, a chip and a reason per call. */
function PreviewSkeleton() {
  return (
    <ul className="ce-calls" aria-hidden="true">
      {[150, 190, 130].map(w => (
        <li key={w} className="ce-call">
          <Skeleton shape="text" width={w} />
          <Skeleton width={84} height={22} />
          <Skeleton shape="text" width={w + 60} />
        </li>
      ))}
    </ul>
  )
}

/** The outside addresses: each with its state, Resend while it has not confirmed, and Remove (Undo in the toast). */
function OutsideList({
  routing,
  toast,
  undoable,
}: {
  routing: Query<EmailRoutingData>
  toast: (text: string) => void
  undoable?: Undoable
}) {
  const t = useT()
  const [busy, setBusy] = useState<string | null>(null)
  const put = (recipient: OutsideRecipient) =>
    setQueryData<EmailRoutingData | undefined>(ROUTING_KEY, d =>
      d
        ? {
            ...d,
            recipients: [...d.recipients.filter(r => r.id !== recipient.id), recipient].sort((a, b) =>
              a.email.localeCompare(b.email),
            ),
          }
        : d,
    )

  async function resend(r: OutsideRecipient) {
    setBusy(r.id)
    try {
      const { recipient } = await callAction<{ recipient: OutsideRecipient }>('emailRecipient.resend', { id: r.id })
      put(recipient)
      toast(t('settings.assistant.emails.outside.resent', { email: r.email }))
    } catch (err) {
      toast(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  async function remove(r: OutsideRecipient) {
    setQueryData<EmailRoutingData | undefined>(ROUTING_KEY, d =>
      d ? { ...d, recipients: d.recipients.filter(x => x.id !== r.id) } : d,
    )
    try {
      await callAction('emailRecipient.remove', { id: r.id })
    } catch (err) {
      put(r)
      return toast(errorText(err))
    }
    const label = t('settings.assistant.emails.outside.removed', { email: r.email })
    const restore = () =>
      void callAction<{ recipient: OutsideRecipient }>('emailRecipient.restore', { id: r.id }).then(
        ({ recipient }) => put(recipient),
        err => toast(errorText(err)),
      )
    if (undoable) undoable(label, '⌫', restore)
    else toast(label)
  }

  return (
    <Section
      id="as-emails-outside"
      title={t('settings.assistant.emails.outside.title')}
      help={t('settings.assistant.emails.outside.help')}
    >
      <Loading
        what={t('settings.assistant.emails.outside.load')}
        loading={!routing.data}
        error={routing.error}
        onRetry={() => void routing.reload()}
        skeleton={<SkeletonOutside />}
      >
        {routing.data && !routing.data.recipients.length ? (
          <ListEmpty>{t('settings.assistant.emails.outside.empty')}</ListEmpty>
        ) : (
          <List label={t('settings.assistant.emails.outside.title')}>
            {routing.data?.recipients.map(r => (
              <ListRow
                key={r.id}
                title={r.email}
                sub={r.label ?? undefined}
                aside={<Badge tone={r.status === 'confirmed' ? 'ok' : 'neutral'}>{t(STATUS_TEXT[r.status])}</Badge>}
                actions={
                  <>
                    {/* A stopped address is asked again only by removing and adding it (email-recipients.ts). */}
                    {r.status !== 'confirmed' && !r.stopped_at && (
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={busy === r.id}
                        title={t('settings.assistant.emails.outside.resendTitle', { email: r.email })}
                        onClick={() => void resend(r)}
                      >
                        {t('settings.assistant.emails.outside.resend')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label={t('settings.assistant.emails.outside.remove', { email: r.email })}
                      title={t('settings.assistant.emails.outside.remove', { email: r.email })}
                      onClick={() => void remove(r)}
                    />
                  </>
                }
              />
            ))}
          </List>
        )}
      </Loading>
    </Section>
  )
}

function SkeletonOutside() {
  return (
    <ul className="k-list sk-k-list" aria-hidden="true">
      {[200, 160].map(w => (
        <li key={w} className="k-row">
          <div className="k-row-line">
            <span className="k-row-main">
              <span className="k-row-title">
                <Skeleton shape="text" width={w} />
              </span>
            </span>
            <Skeleton shape="text" width={64} />
            <Skeleton width={28} height={28} />
          </div>
        </li>
      ))}
    </ul>
  )
}
