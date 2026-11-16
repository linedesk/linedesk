// Server admin › System prompt (LIN-346): the assistant's whole system prompt as one readable text, in the order the
// voice agent builds it (buildInstructions). Its fixed text is editable in place; the variables ({name}, {hours}) are
// chips that cannot change, so an edit always keeps them. The parts and their defaults come from PROMPT_TEXTS in
// @linedesk/actions, the same table the agent reads; an edit is stored with systemPrompt.setPart for every workspace.
import {
  PROMPT_SECTIONS,
  PROMPT_TEXT_KEYS,
  PROMPT_TEXTS,
  type PromptCondition,
  type PromptSection,
  type PromptTextDef,
  type PromptTextKey,
  type SystemPromptData,
  type SystemPromptOverride,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FocusEvent, type FormEvent, type KeyboardEvent, useRef, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Badge, Button, cx, Icon, Note } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { runAdmin } from './api.ts'

const QUERY = 'admin.systemPrompt'
const load = async () => (await runAdmin('systemPrompt.get', {})) as SystemPromptData

const SECTIONS: Record<PromptSection, MessageKey> = {
  role: msg('admin.prompt.section.role'),
  language: msg('admin.prompt.section.language'),
  ai: msg('admin.prompt.section.ai'),
  tone: msg('admin.prompt.section.tone'),
  cannot: msg('admin.prompt.section.cannot'),
  booking: msg('admin.prompt.section.booking'),
  knowledge: msg('admin.prompt.section.knowledge'),
  rules: msg('admin.prompt.section.rules'),
  owner: msg('admin.prompt.section.owner'),
  tools: msg('admin.prompt.section.tools'),
  call: msg('admin.prompt.section.call'),
}

const CONDITIONS: Record<PromptCondition, MessageKey> = {
  noName: msg('admin.prompt.when.noName'),
  oneLanguage: msg('admin.prompt.when.oneLanguage'),
  severalLanguages: msg('admin.prompt.when.severalLanguages'),
  teamLanguage: msg('admin.prompt.when.teamLanguage'),
  notEnglish: msg('admin.prompt.when.notEnglish'),
  aiNever: msg('admin.prompt.when.aiNever'),
  aiAtStart: msg('admin.prompt.when.aiAtStart'),
  aiConsent: msg('admin.prompt.when.aiConsent'),
  toneProfessional: msg('admin.prompt.when.toneProfessional'),
  toneCasual: msg('admin.prompt.when.toneCasual'),
  toneFormal: msg('admin.prompt.when.toneFormal'),
  toneEmpathetic: msg('admin.prompt.when.toneEmpathetic'),
  missing: msg('admin.prompt.when.missing'),
  noBooking: msg('admin.prompt.when.noBooking'),
  noTransfer: msg('admin.prompt.when.noTransfer'),
  noLookup: msg('admin.prompt.when.noLookup'),
  booking: msg('admin.prompt.when.booking'),
  severalTypes: msg('admin.prompt.when.severalTypes'),
  severalCalendars: msg('admin.prompt.when.severalCalendars'),
  changeBookings: msg('admin.prompt.when.changeBookings'),
  changeListed: msg('admin.prompt.when.changeListed'),
  changeListedChecked: msg('admin.prompt.when.changeListedChecked'),
  noChangeBookings: msg('admin.prompt.when.noChangeBookings'),
  knowledge: msg('admin.prompt.when.knowledge'),
  noKnowledge: msg('admin.prompt.when.noKnowledge'),
  transfer: msg('admin.prompt.when.transfer'),
  switchOn: msg('admin.prompt.when.switchOn'),
  switchOff: msg('admin.prompt.when.switchOff'),
  switches: msg('admin.prompt.when.switches'),
  timeZone: msg('admin.prompt.when.timeZone'),
  noHours: msg('admin.prompt.when.noHours'),
  closed: msg('admin.prompt.when.closed'),
  closedBooking: msg('admin.prompt.when.closedBooking'),
  closure: msg('admin.prompt.when.closure'),
  closureBooking: msg('admin.prompt.when.closureBooking'),
  unknownNumber: msg('admin.prompt.when.unknownNumber'),
  testCall: msg('admin.prompt.when.testCall'),
  callerId: msg('admin.prompt.when.callerId'),
  savedContact: msg('admin.prompt.when.savedContact'),
  keepName: msg('admin.prompt.when.keepName'),
  held: msg('admin.prompt.when.held'),
  notes: msg('admin.prompt.when.notes'),
  details: msg('admin.prompt.when.details'),
  history: msg('admin.prompt.when.history'),
}

/** What each variable is filled in with on a call, as its chip says. */
export const VARIABLES: Record<string, MessageKey> = {
  name: msg('admin.prompt.variable.name'),
  main: msg('admin.prompt.variable.main'),
  others: msg('admin.prompt.variable.others'),
  all: msg('admin.prompt.variable.all'),
  team: msg('admin.prompt.variable.team'),
  list: msg('admin.prompt.variable.list'),
  types: msg('admin.prompt.variable.types'),
  calendars: msg('admin.prompt.variable.calendars'),
  knowledge: msg('admin.prompt.variable.knowledge'),
  rules: msg('admin.prompt.variable.rules'),
  lines: msg('admin.prompt.variable.lines'),
  now: msg('admin.prompt.variable.now'),
  timeZone: msg('admin.prompt.variable.timeZone'),
  hours: msg('admin.prompt.variable.hours'),
  number: msg('admin.prompt.variable.number'),
  caller: msg('admin.prompt.variable.caller'),
  callerId: msg('admin.prompt.variable.callerId'),
  conditions: msg('admin.prompt.variable.conditions'),
  notes: msg('admin.prompt.variable.notes'),
  details: msg('admin.prompt.variable.details'),
  history: msg('admin.prompt.variable.history'),
}

/** A text split at its variables: one more text than variables, the variables in between. */
export function splitText(text: string): { texts: string[]; variables: string[] } {
  const texts: string[] = []
  const variables: string[] = []
  let from = 0
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    texts.push(text.slice(from, match.index))
    variables.push(match[1]!)
    from = match.index + match[0].length
  }
  texts.push(text.slice(from))
  return { texts, variables }
}

/** The texts with the variables between them again: `splitText`'s opposite. */
export const joinText = (texts: readonly string[], variables: readonly string[]) =>
  texts.map((text, i) => (i < variables.length ? `${text}{${variables[i]}}` : text)).join('')

/** The text calls use now: the edit while it fits its default, else the default. */
export const textInUse = (key: PromptTextKey, edit: SystemPromptOverride | undefined) =>
  edit?.fits ? edit.text : PROMPT_TEXTS[key].text

function Variable({ name }: { name: string }) {
  const t = useT()
  const label = VARIABLES[name]
  return (
    <span className="adm-prompt-var" contentEditable={false} title={t('admin.prompt.variableHint')}>
      {label ? t(label) : name}
    </span>
  )
}

/** A text with its variables as chips, not editable (the default next to an edit). */
function ReadOnlyText({ text, className }: { text: string; className?: string }) {
  const { texts, variables } = splitText(text)
  return (
    <p className={cx('adm-prompt-text', className)}>
      {texts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text, in order
        <span key={i}>
          {part}
          {i < variables.length && <Variable name={variables[i]!} />}
        </span>
      ))}
    </p>
  )
}

type PartProps = {
  partKey: PromptTextKey
  edit: SystemPromptOverride | undefined
  onSave: (key: PromptTextKey, text: string) => void
  onReset: (key: PromptTextKey) => void
  onEmpty: () => void
}

/**
 * One part, drawn as a text field (LIN-356) so it is clear the text can change: each piece of fixed text between the
 * variables is editable on its own, so the variables stay where they are. Leaving the part saves it; Esc undoes,
 * ⌘↵ saves at once. A form, so admin mode leaves its keys alone.
 */
function Part({ partKey, edit, onSave, onReset, onEmpty }: PartProps) {
  const t = useT()
  const def: PromptTextDef = PROMPT_TEXTS[partKey]
  const current = textInUse(partKey, edit)
  const { texts, variables } = splitText(current)
  const pieces = useRef<(HTMLSpanElement | null)[]>([])
  const [focused, setFocused] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const read = () =>
    joinText(
      texts.map((text, i) => pieces.current[i]?.textContent ?? text),
      variables,
    )
  const restore = () => {
    texts.forEach((text, i) => {
      const piece = pieces.current[i]
      if (piece) piece.textContent = text
    })
    setDirty(false)
  }
  function save() {
    const next = read()
    setDirty(false)
    if (next === current) return
    if (!next.trim()) {
      restore()
      onEmpty()
      return
    }
    onSave(partKey, next)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }
  function onBlur(e: FocusEvent<HTMLFormElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setFocused(false)
    save()
  }
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (!(e.target as HTMLElement).isContentEditable) return
    if (e.key === 'Escape') {
      e.preventDefault()
      restore()
      ;(e.target as HTMLElement).blur()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
    }
  }
  const onSubmit = (e: FormEvent) => e.preventDefault()
  return (
    <form
      className={cx('adm-prompt-part', edit && 'is-edited', focused && 'is-focused')}
      onBlur={onBlur}
      onFocus={() => setFocused(true)}
      onKeyDown={onKeyDown}
      onInput={() => setDirty(read() !== current)}
      onSubmit={onSubmit}
      data-part={partKey}
    >
      {(def.when || edit || saved) && (
        <div className="adm-prompt-meta">
          {def.when && <span className="adm-prompt-when">{t(CONDITIONS[def.when])}</span>}
          {edit && <Badge tone="outline">{t('admin.prompt.edited')}</Badge>}
          {edit?.defaultChanged && (
            <Badge tone="info" title={t('admin.prompt.defaultChangedHint')}>
              {t('admin.prompt.defaultChanged')}
            </Badge>
          )}
          {edit && !edit.fits && (
            <Badge tone="info" title={t('admin.prompt.notInUseHint')}>
              {t('admin.prompt.notInUse')}
            </Badge>
          )}
          {saved && (
            <span className="adm-prompt-saved" role="status">
              <Icon name="check" size={12} /> {t('admin.prompt.saved')}
            </span>
          )}
          {edit && (
            <span className="adm-prompt-tools">
              <Button size="sm" variant="ghost" icon="restart" onClick={() => onReset(partKey)}>
                {t('admin.prompt.reset')}
              </Button>
            </span>
          )}
        </div>
      )}
      {/* The key: a reset or a saved edit shows its new text, also in the pieces the browser edited. */}
      <p className="adm-prompt-text" key={current}>
        {texts.map((text, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one text, in order; the text is the parent's key
          <span key={i}>
            <span
              ref={el => {
                pieces.current[i] = el
              }}
              className="adm-prompt-edit"
              contentEditable="plaintext-only"
              suppressContentEditableWarning
              spellCheck={false}
              role="textbox"
              tabIndex={0}
              aria-multiline
              aria-label={t('admin.prompt.pieceLabel')}
              title={t('admin.prompt.editHint')}
            >
              {text}
            </span>
            {i < variables.length && <Variable name={variables[i]!} />}
          </span>
        ))}
      </p>
      {focused && (
        <p className="adm-prompt-hint">{dirty ? t('admin.prompt.unsaved') : t('admin.prompt.autoSaveHint')}</p>
      )}
      {edit && (
        <details className="adm-prompt-default">
          <summary>{t('admin.prompt.defaultText')}</summary>
          <ReadOnlyText text={def.text} />
        </details>
      )}
    </form>
  )
}

export function SystemPrompt() {
  const t = useT()
  const query = useQuery(QUERY, load)
  const [problem, setProblem] = useState<string | null>(null)
  const edits = new Map((query.data?.overrides ?? []).map(edit => [edit.key, edit]))
  // Every section starts collapsed: the page is an overview first, and only what the admin opens is shown in full.
  const [open, setOpen] = useState<ReadonlySet<PromptSection>>(() => new Set())
  const allOpen = open.size === PROMPT_SECTIONS.length
  const toggle = (section: PromptSection) =>
    setOpen(current => {
      const next = new Set(current)
      if (!next.delete(section)) next.add(section)
      return next
    })

  /** Shown at once (rule 3), then as the server stored it; on a failure the page goes back. */
  async function change(run: () => Promise<unknown>, optimistic: SystemPromptData) {
    const before = query.data
    setProblem(null)
    setQueryData<SystemPromptData | undefined>(QUERY, optimistic)
    try {
      setQueryData<SystemPromptData | undefined>(QUERY, (await run()) as SystemPromptData)
    } catch (e) {
      setQueryData<SystemPromptData | undefined>(QUERY, before)
      setProblem(e instanceof Error ? e.message : t('admin.prompt.failed'))
    }
  }
  const others = (key: PromptTextKey) => (query.data?.overrides ?? []).filter(edit => edit.key !== key)
  const inOrder = (overrides: SystemPromptOverride[]) =>
    overrides.sort((a, b) => PROMPT_TEXT_KEYS.indexOf(a.key) - PROMPT_TEXT_KEYS.indexOf(b.key))

  const save = (key: PromptTextKey, text: string) => {
    const isDefault = text === PROMPT_TEXTS[key].text
    const edit: SystemPromptOverride = {
      key,
      text,
      defaultChanged: false,
      fits: true,
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    }
    void change(() => runAdmin('systemPrompt.setPart', { key, text }), {
      overrides: inOrder(isDefault ? others(key) : [...others(key), edit]),
    })
  }
  const reset = (key: PromptTextKey) =>
    void change(() => runAdmin('systemPrompt.resetPart', { key }), { overrides: others(key) })

  return (
    <div className="adm-prompt">
      <Note>{t('admin.prompt.intro')}</Note>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
      <Loading
        what={t('admin.prompt.what')}
        loading={!query.data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={8} columns={1} className="adm-sk-rows" />}
      >
        <div className="adm-prompt-toolbar">
          <Button
            size="sm"
            variant="ghost"
            icon={allOpen ? 'up' : 'down'}
            onClick={() => setOpen(allOpen ? new Set() : new Set(PROMPT_SECTIONS))}
            aria-label={allOpen ? t('admin.prompt.collapseAll') : t('admin.prompt.expandAll')}
          >
            {allOpen ? t('admin.prompt.collapseAll') : t('admin.prompt.expandAll')}
          </Button>
        </div>
        {PROMPT_SECTIONS.map(section => {
          const keys = PROMPT_TEXT_KEYS.filter(key => PROMPT_TEXTS[key].section === section)
          const edited = keys.filter(key => edits.has(key)).length
          const isOpen = open.has(section)
          const first = keys[0]
          return (
            <section
              key={section}
              className={cx('adm-card adm-prompt-section', isOpen && 'is-open')}
              aria-label={t(SECTIONS[section])}
            >
              <button
                type="button"
                className="adm-prompt-head"
                aria-expanded={isOpen}
                aria-controls={`adm-prompt-${section}`}
                title={isOpen ? t('admin.prompt.collapse') : t('admin.prompt.expand')}
                onClick={() => toggle(section)}
              >
                <Icon name="down" size={14} className="adm-prompt-chevron" />
                <h3>{t(SECTIONS[section])}</h3>
                <span className="adm-prompt-count">{t('admin.prompt.parts', { count: keys.length })}</span>
                {edited > 0 && <Badge tone="outline">{t('admin.prompt.editedCount', { count: edited })}</Badge>}
              </button>
              {!isOpen && first && (
                <ReadOnlyText text={textInUse(first, edits.get(first))} className="adm-prompt-preview" />
              )}
              {isOpen && (
                <div id={`adm-prompt-${section}`} className="adm-prompt-parts">
                  {keys.map(key => (
                    <Part
                      key={key}
                      partKey={key}
                      edit={edits.get(key)}
                      onSave={save}
                      onReset={reset}
                      onEmpty={() => setProblem(t('admin.prompt.empty'))}
                    />
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </Loading>
    </div>
  )
}
