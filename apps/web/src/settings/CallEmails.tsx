// Settings › Assistant › Call emails (LIN-369, LIN-470): who gets the email about which call, as a list of rules.
// "Always send to" members get every call email; each rule has the calls it is for in a few words, the members it
// sends to and optionally one of them to assign the call to. After a call a language model only says which rules fit;
// the code picks the recipients and the assignee (apps/api/src/email-routing.ts). Rules are on only when the instance
// admin has set up a language model; without one the page shows only "Always send to". The rules are part of the
// assistant's draft and saved with the page. Recipients are members only, shown with their email address.
import {
  EMAIL_ALWAYS_MAX,
  EMAIL_RULE_TO_MAX,
  EMAIL_RULE_WHEN_MAX,
  EMAIL_RULES_MAX,
  type EmailRoutingData,
} from '@linedesk/actions'
import type { EmailRule, EmailRules, WorkspaceMember } from '@linedesk/db/types'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useQuery } from '../cachedQuery.ts'
import { memberAvatar, memberLabel, useMembers } from '../team/members.ts'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Input } from '../ui/form.tsx'
import { Avatar, Button, Icon } from '../ui/kit.tsx'
import { Loading, Skeleton, useLoadState } from '../ui/LoadStates.tsx'
import { type SearchOption, SearchSelect, searchOptions } from '../ui/SearchSelect.tsx'
import { Field, Section } from './fields.tsx'
import { readAction } from './settings-api.ts'
import './call-emails.css'

const ROUTING_KEY = 'emailRouting.get'
const loadRouting = () => readAction<EmailRoutingData>(ROUTING_KEY)

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
  canEdit: boolean
  undoable?: Undoable
  /** Save was tried: a rule without a topic shows its error. */
  showErrors: boolean
}

const newRule = (): EmailRule => ({ id: crypto.randomUUID(), when: '', to: [], assign: null })

export function CallEmails({ name, rules, onChange, canEdit, undoable, showErrors }: Props) {
  const t = useT()
  const format = useFormat()
  const members = useMembers()
  const membersState = useLoadState('workspace_members')
  const routing = useQuery<EmailRoutingData>(canEdit ? ROUTING_KEY : null, loadRouting)
  const emailOff = (userId: string) => routing.data?.members.find(m => m.userId === userId)?.emailOn === false
  const emailOf = (userId: string) => routing.data?.members.find(m => m.userId === userId)?.email
  // Rules need a language model; without one only "Always send to" works, so only it shows. Members who cannot edit
  // do not read routing.data: they see the rules as saved.
  const llmKnown = !canEdit || routing.data !== undefined || routing.error !== null
  const showRules = !canEdit || routing.data?.llm === true
  const named = [...new Set([...rules.always, ...(showRules ? rules.rules.flatMap(r => r.to) : [])])]
  const off = named.filter(emailOff)
  const label = (userId: string) => memberLabel(members.find(m => m.user_id === userId))

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
        showRules ? 'settings.assistant.emails.description' : 'settings.assistant.emails.descriptionAlways',
        { name },
      )}
      help={t(showRules ? 'settings.assistant.emails.help' : 'settings.assistant.emails.helpAlways', { name })}
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
        loading={membersState === 'loading' || !llmKnown}
        error={membersState === 'slow'}
        skeleton={<Skeleton width="100%" height={112} />}
      >
        <Field
          id="as-emails-always"
          label={t('settings.assistant.emails.always.label')}
          help={t('settings.assistant.emails.always.help')}
        >
          <People
            id="as-emails-always"
            ids={rules.always}
            max={EMAIL_ALWAYS_MAX}
            members={members}
            emailOff={emailOff}
            emailOf={emailOf}
            disabled={!canEdit}
            onChange={always => onChange(rs => ({ ...rs, always }))}
          />
        </Field>
        {showRules && rules.rules.length > 0 ? (
          <ol className="ce-rules">
            {rules.rules.map((rule, i) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                index={i}
                members={members}
                emailOff={emailOff}
                emailOf={emailOf}
                disabled={!canEdit}
                showErrors={showErrors}
                onChange={change => setRule(rule.id, change)}
                onRemove={() => removeRule(rule, i)}
              />
            ))}
          </ol>
        ) : (
          !rules.always.length && <p className="help">{t('settings.assistant.emails.empty')}</p>
        )}
        {off.length > 0 && (
          <p className="help">
            {t('settings.assistant.emails.emailsOff', { count: off.length, names: format.list(off.map(label)) })}
          </p>
        )}
      </Loading>
    </Section>
  )
}

/** One rule: its number, what the calls are about and delete on top, then who gets them and who gets them assigned. */
function RuleCard({
  rule,
  index,
  members,
  emailOff,
  emailOf,
  disabled,
  showErrors,
  onChange,
  onRemove,
}: {
  rule: EmailRule
  index: number
  members: WorkspaceMember[]
  emailOff: (userId: string) => boolean
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
    ...rule.to.map(id => ({ value: id, label: memberLabel(members.find(m => m.user_id === id)) })),
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
          emailOff={emailOff}
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
  emailOff,
  emailOf,
  disabled,
  onChange,
}: {
  id: string
  ids: string[]
  max: number
  members: WorkspaceMember[]
  emailOff: (userId: string) => boolean
  emailOf: (userId: string) => string | undefined
  disabled: boolean
  onChange: (ids: string[]) => void
}) {
  const t = useT()
  const options = members
    .filter(m => !m.disabled && !ids.includes(m.user_id))
    .map(m => ({ value: m.user_id, label: memberLabel(m), meta: emailOf(m.user_id) }))
  return (
    <div className="ce-chips">
      {ids.map(userId => {
        const member = members.find(m => m.user_id === userId)
        const label = memberLabel(member)
        const email = emailOf(userId)
        return (
          <span key={userId} className="ce-chip">
            <Avatar name={label} size={20} src={memberAvatar(member)} />
            {label}
            {email && <span className="ce-chip-email">{email}</span>}
            {emailOff(userId) && (
              <span className="ce-chip-note" title={t('settings.assistant.emails.chip.emailsOffTip')}>
                {t('settings.assistant.emails.chip.emailsOff')}
              </span>
            )}
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
