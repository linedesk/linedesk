// Settings › Assistant › Who hears about calls (LIN-369, LIN-470, LIN-768): the one place for call emails. One row per
// member with their "Email for every call" switch (their own notification setting in this workspace), a row for new
// teammates (the team default they start with), then the rules: each rule has the calls it is about in a few words, the
// members it sends to (also with "every call" off) and optionally one of them to assign the call to. After a call a
// language model only says which rules fit; the code picks the recipients and the assignee
// (apps/api/src/email-routing.ts). Rules are on only when the instance admin has set up a language model; without one
// the page shows only the switches. The switches apply at once (everyone changes their own; owners and admins the
// others' and the default, an admin never an owner's); the rules are part of the assistant's draft and saved with the
// page. Recipients are members only, shown with their email address.
import {
  type CallEmailsData,
  EMAIL_RULE_TO_MAX,
  EMAIL_RULE_WHEN_MAX,
  EMAIL_RULES_MAX,
  type EmailRoutingData,
} from '@linedesk/actions'
import type { EmailRule, EmailRules, WorkspaceMember } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { useRun } from '../store.tsx'
import { useSupportAccess } from '../supportAccess.ts'
import { memberAvatar, memberLabel, useMembers } from '../team/members.ts'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Input } from '../ui/form.tsx'
import { Avatar, Button, Icon } from '../ui/kit.tsx'
import { Loading, useLoadState } from '../ui/LoadStates.tsx'
import { type SearchOption, SearchSelect, searchOptions } from '../ui/SearchSelect.tsx'
import { Section, SkeletonSwitchRows, SwitchRow } from './fields.tsx'
import { readAction } from './settings-api.ts'
import './call-emails.css'

const ROUTING_KEY = 'emailRouting.get'
const loadRouting = () => readAction<EmailRoutingData>(ROUTING_KEY)
/** Who hears about calls, for every member (callEmails.get). */
export const CALL_EMAILS_KEY = 'callEmails.get'
const loadCallEmails = () => readAction<CallEmailsData>(CALL_EMAILS_KEY)

/** Revert a change from a toast's Undo (Workspace's undo stack, also Z). */
export type Undoable = (label: string, key: string, revert: () => void) => void

/** The id of a rule's "When the call is about" field, for the page's save check to put the cursor there. */
export const emailRuleWhenId = (index: number) => `as-rule-when-${index}`

/** Members by label, then those whose email address contains what was typed. */
const searchPeople = (options: readonly SearchOption[], query: string) => {
  const byName = searchOptions(options, query)
  const q = query.trim().toLowerCase()
  const byEmail = q ? options.filter(o => !byName.includes(o) && o.meta?.toLowerCase().includes(q)) : []
  return [...byName, ...byEmail]
}

type Props = {
  /** The assistant's name as the page says it. */
  name: string
  rules: EmailRules
  /** Takes a change of the latest rules, so an Undo puts a rule back into the draft as it is then. */
  onChange: (update: (rules: EmailRules) => EmailRules) => void
  /** Owners and admins: the rules, the teammates' switches and the one for new teammates. */
  canEdit: boolean
  undoable?: Undoable
  /** Save was tried: a rule without a topic shows its error. */
  showErrors: boolean
}

const newRule = (): EmailRule => ({ id: crypto.randomUUID(), when: '', to: [], assign: null })

/** The switches as the page shows them before the server answers; the server's answer comes with the next read. */
const patchCallEmails = (change: (data: CallEmailsData) => CallEmailsData) =>
  setQueryData<CallEmailsData | undefined>(CALL_EMAILS_KEY, data => (data ? change(data) : data))

export function CallEmails({ name, rules, onChange, canEdit, undoable, showErrors }: Props) {
  const t = useT()
  const members = useMembers()
  const membersState = useLoadState('workspace_members')
  const routing = useQuery<EmailRoutingData>(canEdit ? ROUTING_KEY : null, loadRouting)
  const hears = useQuery<CallEmailsData>(CALL_EMAILS_KEY, loadCallEmails)
  const emailOf = (userId: string) =>
    (routing.data?.members ?? hears.data?.members)?.find(m => m.userId === userId)?.email
  // Rules need a language model; without one only the switches work, so only they show, for everyone.
  const showRules = hears.data?.llm === true

  const setRule = (id: string, change: (r: EmailRule) => EmailRule) =>
    onChange(rs => ({ ...rs, rules: rs.rules.map(r => (r.id === id ? change(r) : r)) }))

  function addRule() {
    const at = rules.rules.length
    onChange(rs => ({ ...rs, rules: [...rs.rules, newRule()] }))
    setTimeout(() => document.getElementById(emailRuleWhenId(at))?.focus(), 0)
  }

  function removeRule(rule: EmailRule, index: number) {
    onChange(rs => ({ ...rs, rules: rs.rules.filter(r => r.id !== rule.id) }))
    undoable?.(t('settings.assistant.emails.rule.removed', { n: index + 1 }), '⌫', () =>
      onChange(rs =>
        rs.rules.some(r => r.id === rule.id)
          ? rs
          : { ...rs, rules: [...rs.rules.slice(0, index), rule, ...rs.rules.slice(index)] },
      ),
    )
  }

  return (
    <Section
      id="as-emails"
      title={t('settings.assistant.emails.title')}
      description={t(
        showRules ? 'settings.assistant.emails.description' : 'settings.assistant.emails.descriptionNoRules',
      )}
      help={t(showRules ? 'settings.assistant.emails.help' : 'settings.assistant.emails.helpNoRules', { name })}
      actions={
        canEdit &&
        showRules && (
          <Button
            size="sm"
            icon="plus"
            disabled={rules.rules.length >= EMAIL_RULES_MAX}
            title={
              rules.rules.length >= EMAIL_RULES_MAX
                ? t('settings.assistant.emails.rule.full', { max: EMAIL_RULES_MAX })
                : t('settings.assistant.emails.rule.addTip')
            }
            onClick={addRule}
          >
            {t('settings.assistant.emails.rule.add')}
          </Button>
        )
      }
    >
      <Loading
        what={t('settings.assistant.emails.load')}
        loading={membersState === 'loading' || !hears.data}
        error={membersState === 'slow' ? true : hears.data ? null : hears.error}
        onRetry={() => void hears.reload()}
        skeleton={<SkeletonSwitchRows rows={Math.max(2, members.filter(m => !m.disabled).length + 1)} lead />}
      >
        {hears.data && <WhoHears data={hears.data} members={members} canEdit={canEdit} showRules={showRules} />}
        {showRules && rules.rules.length > 0 && (
          <ol className="ce-rules">
            {rules.rules.map((rule, i) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                index={i}
                members={members}
                emailOf={emailOf}
                disabled={!canEdit}
                showErrors={showErrors}
                onChange={change => setRule(rule.id, change)}
                onRemove={() => removeRule(rule, i)}
              />
            ))}
          </ol>
        )}
      </Loading>
    </Section>
  )
}

/**
 * One row per member (you first, then by name) with their "Email for every call", and the row for new teammates.
 * Yours is always yours to switch; the others' and the default only for owners and admins, an owner's only for an
 * owner (team.updateMemberNotifications refuses the rest).
 */
function WhoHears({
  data,
  members,
  canEdit,
  showRules,
}: {
  data: CallEmailsData
  members: WorkspaceMember[]
  canEdit: boolean
  showRules: boolean
}) {
  const t = useT()
  const run = useRun()
  // Support access shows the workspace as its people see it; it changes nobody's settings.
  const readOnly = !!useSupportAccess()
  const myRole = members.find(m => m.user_id === data.you)?.role
  const everyCall = (userId: string) => data.members.find(m => m.userId === userId)?.everyCall ?? false
  const shown = members
    .filter(m => !m.disabled && data.members.some(d => d.userId === m.user_id))
    .sort((a, b) => Number(b.user_id === data.you) - Number(a.user_id === data.you))
  const mayChange = (m: WorkspaceMember) =>
    !readOnly && (m.user_id === data.you || (canEdit && (m.role !== 'owner' || myRole === 'owner')))
  const line = (on: boolean) =>
    on
      ? t('settings.assistant.emails.member.everyCall')
      : showRules
        ? t('settings.assistant.emails.member.onlyRules')
        : t('settings.assistant.emails.member.none')

  function setMember(m: WorkspaceMember, on: boolean) {
    patchCallEmails(d => ({
      ...d,
      members: d.members.map(x => (x.userId === m.user_id ? { ...x, everyCall: on } : x)),
    }))
    if (m.user_id === data.you) void run('notifications.update', { email: on })
    else void run('team.updateMemberNotifications', { memberId: m.id, email: on })
  }

  function setNewTeammates(on: boolean) {
    patchCallEmails(d => ({ ...d, newTeammates: on }))
    void run('notifications.setDefaults', { email: on })
  }

  return (
    <div className="st-swlist ce-people">
      {shown.map(m => {
        const label = memberLabel(m, data.members.find(x => x.userId === m.user_id)?.email)
        const editable = mayChange(m)
        return (
          <SwitchRow
            key={m.user_id}
            lead={<Avatar name={label} size={24} src={memberAvatar(m)} />}
            title={m.user_id === data.you ? t('settings.assistant.emails.member.you', { name: label }) : label}
            description={line(everyCall(m.user_id))}
            on={everyCall(m.user_id)}
            onChange={on => setMember(m, on)}
            disabled={!editable}
            tip={
              editable || readOnly
                ? undefined
                : canEdit
                  ? t('settings.assistant.emails.member.ownerOnly')
                  : t('settings.assistant.emails.member.notYours')
            }
          />
        )
      })}
      <SwitchRow
        lead={
          <span className="ce-lead-new" aria-hidden="true">
            <Icon name="plus" size={12} />
          </span>
        }
        title={t('settings.assistant.emails.newTeammates.title')}
        description={
          data.newTeammates
            ? t('settings.assistant.emails.newTeammates.everyCall')
            : showRules
              ? t('settings.assistant.emails.newTeammates.onlyRules')
              : t('settings.assistant.emails.newTeammates.none')
        }
        on={data.newTeammates}
        onChange={setNewTeammates}
        disabled={!canEdit || readOnly}
        tip={canEdit || readOnly ? undefined : t('settings.assistant.emails.member.notYours')}
      />
    </div>
  )
}

/** One rule: its number, what the calls are about and delete on top, then who gets them and who gets them assigned. */
function RuleCard({
  rule,
  index,
  members,
  emailOf,
  disabled,
  showErrors,
  onChange,
  onRemove,
}: {
  rule: EmailRule
  index: number
  members: WorkspaceMember[]
  emailOf: (userId: string) => string | undefined
  disabled: boolean
  showErrors: boolean
  onChange: (change: (r: EmailRule) => EmailRule) => void
  onRemove: () => void
}) {
  const t = useT()
  const whenMissing = showErrors && !rule.when.trim()
  const assignOptions: SelectOption<string>[] = [
    { value: '', label: t('settings.assistant.emails.rule.nobody') },
    ...rule.to.map(id => {
      const member = members.find(m => m.user_id === id)
      return { value: id, label: memberLabel(member, emailOf(id)) }
    }),
  ]
  return (
    <li className="ce-rule">
      <div className="ce-rule-head">
        <span className="ce-rule-n" aria-hidden>
          {index + 1}
        </span>
        <label className="ce-rule-label" htmlFor={emailRuleWhenId(index)}>
          {t('settings.assistant.emails.rule.when')}
        </label>
        <Input
          id={emailRuleWhenId(index)}
          size="sm"
          className="ce-rule-when"
          value={rule.when}
          maxLength={EMAIL_RULE_WHEN_MAX}
          placeholder={t('settings.assistant.emails.rule.whenPlaceholder')}
          aria-label={t('settings.assistant.emails.rule.whenName', { n: index + 1 })}
          invalid={whenMissing}
          disabled={disabled}
          onChange={e => {
            const when = e.target.value
            onChange(r => ({ ...r, when }))
          }}
        />
        {!disabled && (
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            title={t('settings.assistant.emails.rule.remove')}
            aria-label={t('settings.assistant.emails.rule.removeName', { n: index + 1 })}
            onClick={onRemove}
          />
        )}
      </div>
      {whenMissing && <p className="ce-rule-error">{t('settings.assistant.emails.rule.whenMissing')}</p>}
      <div className="ce-rule-body">
        <span className="ce-rule-label">{t('settings.assistant.emails.rule.to')}</span>
        <People
          id={`as-rule-to-${index}`}
          ids={rule.to}
          max={EMAIL_RULE_TO_MAX}
          members={members}
          emailOf={emailOf}
          disabled={disabled}
          onChange={to => onChange(r => ({ ...r, to, assign: r.assign && to.includes(r.assign) ? r.assign : null }))}
        />
        <span className="ce-rule-label">{t('settings.assistant.emails.rule.assign')}</span>
        <div className="ce-rule-assign">
          <Select
            id={`as-rule-assign-${index}`}
            size="sm"
            value={rule.assign ?? ''}
            options={assignOptions}
            label={t('settings.assistant.emails.rule.assignName', { n: index + 1 })}
            disabled={disabled || !rule.to.length}
            onChange={id => onChange(r => ({ ...r, assign: id || null }))}
          />
        </div>
      </div>
    </li>
  )
}

/** Member chips (name and email address), each with a remove button, and a picker to add one more. */
function People({
  id,
  ids,
  max,
  members,
  emailOf,
  disabled,
  onChange,
}: {
  id: string
  ids: string[]
  max: number
  members: WorkspaceMember[]
  emailOf: (userId: string) => string | undefined
  disabled: boolean
  onChange: (ids: string[]) => void
}) {
  const t = useT()
  const options = members
    .filter(m => !m.disabled && !ids.includes(m.user_id))
    .map(m => {
      const email = emailOf(m.user_id)
      const label = memberLabel(m, email)
      // Without a name the label is the email already: it shows once.
      return { value: m.user_id, label, meta: label === email ? undefined : email }
    })
  return (
    <div className="ce-chips">
      {ids.map(userId => {
        const member = members.find(m => m.user_id === userId)
        const email = emailOf(userId)
        const label = memberLabel(member, email)
        return (
          <span key={userId} className="ce-chip">
            <Avatar name={label} size={20} src={memberAvatar(member)} />
            {label}
            {email && email !== label && <span className="ce-chip-email">{email}</span>}
            {!disabled && (
              <button
                type="button"
                className="ce-chip-x"
                title={t('settings.assistant.emails.remove', { member: label })}
                aria-label={t('settings.assistant.emails.remove', { member: label })}
                onClick={() => onChange(ids.filter(x => x !== userId))}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </span>
        )
      })}
      {!disabled && ids.length < max && options.length > 0 && (
        <span className="ce-add">
          <SearchSelect
            id={id}
            value=""
            options={options}
            search={searchPeople}
            listWidth={380}
            label={t('settings.assistant.emails.add')}
            empty={t('settings.assistant.emails.add')}
            onChange={userId => userId && onChange([...ids, userId])}
          />
        </span>
      )}
    </div>
  )
}
