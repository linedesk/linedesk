// Settings › Assistant › Voice: suggested voices (the curated ones and the workspace's clones, or for other languages
// the voices that perform them) as compact rows with a play button, and More voices: every voice of every provider
// with a key, with search and filters, opened on the assistant's languages. The assistant's languages decide the voice:
// when they change and the voice can't perform them all, it follows (with Undo). Each row says which of them the voice
// performs ("Native German · English", "German with an American accent"); samples are spoken in the main language
// where the provider has no sample of its own. Cloning a voice where the provider can. The pick is part of the page's draft (Save); cloning
// saves at once, since the provider creates the voice right away.
import {
  CLONE_CONSENT_TEXT,
  type CatalogProvider,
  type ProviderFailureReason,
  providerFailureReasons,
  providerFailureText,
  providerSpec,
  REALTIME_DEFAULT_VOICE,
  REALTIME_VOICE_PROVIDER,
  type VoiceCatalogData,
  type VoiceCloneData,
  type VoiceOptionsData,
} from '@linedesk/actions'
import { T, useFormat, useT } from '@linedesk/i18n/react'
import { adminLink } from '../ui/AppLink.tsx'
import { i18n } from '../i18n/index.tsx'
import { providerAudience } from '../providerAudience.ts'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { fetchQuery, refreshQuery, useQuery } from '../cachedQuery.ts'
import { workspaceHeaders } from '../tabWorkspace.ts'
import { Checkbox, Select } from '../ui/controls.tsx'
import { FormMessage } from '../ui/form.tsx'
import { HelpTip } from '../ui/HelpTip.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import { Loading, Skeleton, SkeletonList } from '../ui/LoadStates.tsx'
import { Field, Section, TextInput } from './fields.tsx'
import { MissingProviderNote } from './MissingProviderNote.tsx'
import { readAction, useWriteAction } from './settings-api.ts'
import {
  ASSISTANT_FILTER,
  ASSISTANT_LANGUAGES,
  byLanguageFit,
  cloneProblem,
  coverageNote,
  type FollowedVoice,
  facetValues,
  fileToBase64,
  filterVoices,
  followedNotice,
  followLanguages,
  languageDefaultPick,
  languageLabel,
  languageName,
  missingNativeNote,
  oncePerVoice,
  type PickerVoice,
  previewProblem,
  previewUrl,
  realtimePickerVoices,
  suggestedForLanguage,
  usableLanguageDefault,
  type VoiceFilter,
  voiceFacts,
  voiceInEffect,
  voiceKey,
} from './voiceModel.ts'

const VOICE_OPTIONS = 'voice.options'
const VOICE_CATALOG = 'voice.catalog'
const loadOptions = () => readAction<VoiceOptionsData>(VOICE_OPTIONS)
/** Every voice of the providers with a key (voice.catalog); the server caches it a few minutes. */
const loadCatalog = () => readAction<VoiceCatalogData>(VOICE_CATALOG)
/** The voices of the provider in effect; the same for every assistant of the install. */
export const useVoiceOptions = () => useQuery(VOICE_OPTIONS, loadOptions, { persist: true })
/**
 * Reads the providers' voices ahead: for an assistant in another language than English, Suggested lists the voices
 * native in it from this list, so a screen that is about to show the Voice card (onboarding, after the country) has it.
 */
export const preloadVoiceCatalog = () => fetchQuery(VOICE_CATALOG, loadCatalog, { persist: true })
/** How many voices More voices shows at first, and adds per "Show more". */
const PAGE = 30
/**
 * The Voice card's skeleton is the realtime card's shape (default voice, one more, More voices, a line of help): what a
 * new assistant shows where a realtime model is set up. The voice providers' card lists as many rows as the provider
 * has suggested voices; it can't be known before the options come.
 */
const VOICE_SKELETON_ROWS = 2

type PreviewFailure = { key: string; message: string }

/** The sample as a playable URL, or why there is none. Fetched first so a refusal can say why. */
async function loadPreview(
  key: string,
  voiceId: string,
  provider: string | null,
  language: string,
): Promise<string | PreviewFailure> {
  const res = await fetch(previewUrl(voiceId, provider, language), {
    credentials: 'include',
    headers: workspaceHeaders(),
  }).catch(() => null)
  if (!res?.ok || !res.headers.get('content-type')?.startsWith('audio/')) {
    const body = (await res?.json().catch(() => null)) as { error?: string; message?: string } | null
    return { key, message: previewProblem(res?.status ?? 0, body?.error, body?.message) }
  }
  return URL.createObjectURL(await res.blob())
}

/**
 * One preview at a time: playing another stops the first. A sample is fetched once per page view and language (the
 * assistant's main language, which samples are spoken in). `progress` (0–1) of the one playing, for its ring.
 */
function usePreview(activeProvider: string | null, language: string) {
  const t = useT()
  const audio = useRef<HTMLAudioElement | null>(null)
  const loaded = useRef(new Map<string, string>())
  /** The voice the last click asked for; a sample that arrives after another click is not played. */
  const wanted = useRef<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [failed, setFailed] = useState<PreviewFailure | null>(null)
  useEffect(
    () => () => {
      audio.current?.pause()
      for (const url of loaded.current.values()) URL.revokeObjectURL(url)
    },
    [],
  )
  /** `key`: which button plays it, when two rows play the same voice (Default voice and Jessica). */
  async function toggle(voice: PickerVoice, key = voiceKey(voice.provider, voice.id)) {
    audio.current?.pause()
    audio.current = null
    setFailed(null)
    setPlaying(null)
    setProgress(0)
    if (wanted.current === key) {
      wanted.current = null
      return setLoading(null)
    }
    wanted.current = key
    const sample = `${key}|${language}`
    let url = loaded.current.get(sample)
    if (!url) {
      setLoading(key)
      const result = await loadPreview(
        key,
        voice.id,
        voice.provider === activeProvider ? null : voice.provider,
        language,
      )
      if (typeof result === 'string') loaded.current.set(sample, result)
      if (wanted.current !== key) return
      setLoading(null)
      if (typeof result !== 'string') {
        wanted.current = null
        return setFailed(result)
      }
      url = result
    }
    const next = new Audio(url)
    audio.current = next
    setPlaying(key)
    const stop = () => {
      if (wanted.current === key) wanted.current = null
      setPlaying(p => (p === key ? null : p))
    }
    next.ontimeupdate = () => next.duration && setProgress(next.currentTime / next.duration)
    next.onended = stop
    next.onerror = () => {
      stop()
      setFailed({ key, message: t('settings.voice.preview.notPlayed') })
    }
    void next.play().catch(stop)
  }
  return { playing, loading, progress, failed, toggle }
}
type Preview = ReturnType<typeof usePreview>

const RING = 2 * Math.PI * 13

type PlayProps = {
  /** null: nothing to play; the button shows disabled with `unavailable` as its tooltip. */
  voice: PickerVoice | null
  preview: Preview
  /** The name it is announced by, when not the voice's own ("Default voice"). */
  label?: string
  playKey?: string
  unavailable?: string
}

/** Play, or while it plays: a moving waveform with the progress around it; hover or focus shows stop. */
function PlayButton({ voice, preview, label, playKey, unavailable }: PlayProps) {
  const t = useT()
  const name = label ?? voice?.name ?? ''
  if (!voice)
    return (
      // aria-disabled, not disabled: a disabled button gets no hover, so its tooltip would never show.
      <button
        type="button"
        className="vp-play is-off"
        aria-disabled="true"
        aria-label={t('settings.voice.play', { name })}
        title={unavailable}
      >
        <svg className="vp-ring" viewBox="0 0 30 30" aria-hidden="true">
          <circle cx="15" cy="15" r="13" />
        </svg>
        <Icon name="play" size={14} className="vp-play-icon" />
      </button>
    )
  const key = playKey ?? voiceKey(voice.provider, voice.id)
  const playing = preview.playing === key
  const loading = preview.loading === key
  const busy = playing || loading
  return (
    <button
      type="button"
      className={cx('vp-play', playing && 'is-playing', loading && 'is-loading')}
      aria-label={busy ? t('settings.voice.stop', { name }) : t('settings.voice.play', { name })}
      aria-busy={loading || undefined}
      title={busy ? t('settings.voice.stopTip', { name }) : t('settings.voice.playTip', { name })}
      onClick={() => void preview.toggle(voice, key)}
    >
      <svg className="vp-ring" viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r="13" />
        {playing && (
          <circle
            className="vp-ring-done"
            cx="15"
            cy="15"
            r="13"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - preview.progress)}
          />
        )}
      </svg>
      {playing ? (
        <span className="vp-bars" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : (
        !loading && <Icon name="play" size={14} className="vp-play-icon" />
      )}
      {busy && <span className="vp-stop" aria-hidden="true" />}
    </button>
  )
}

type RowProps = {
  /**
   * null: the install's default voice, named by its own voice name ("Jessica (default)"); `defaultSample` is the
   * voice it stands for, `defaultNote` the line under it.
   */
  voice: PickerVoice | null
  defaultSample?: { provider: string; id: string; name: string | null } | null
  defaultNote?: string
  checked: boolean
  onPick: () => void
  disabled: boolean
  preview: Preview
  facts?: string
}

function VoiceRow({ voice, defaultSample, defaultNote, checked, onPick, disabled, preview, facts }: RowProps) {
  const t = useT()
  const defaultName = defaultSample?.name
    ? t('settings.voice.defaultNamed', { name: defaultSample.name })
    : t('settings.voice.default')
  const description = voice ? voice.description : (defaultNote ?? null)
  return (
    <div className={cx('vp-row', checked && 'on')}>
      <label className="vp-pick">
        <input type="radio" name="voice" className="vp-radio" checked={checked} disabled={disabled} onChange={onPick} />
        <span className="vp-dot" aria-hidden="true" />
        <span className="vp-text">
          <span className="vp-name">{voice ? voice.name : defaultName}</span>
          {description && (
            <span className="vp-desc" title={description.length > 60 ? description : undefined}>
              {description}
            </span>
          )}
        </span>
        {facts && <span className="vp-facts">{facts}</span>}
      </label>
      {voice ? (
        <PlayButton voice={voice} preview={preview} />
      ) : (
        <PlayButton
          voice={defaultSample ? { ...defaultSample, name: defaultName, description: null } : null}
          label={defaultName}
          playKey="default"
          preview={preview}
          unavailable={t('settings.voice.noDefaultSample')}
        />
      )}
    </div>
  )
}

/** "All …" plus the values in the list; null when there is nothing to choose between. */
function filterOptions(all: string, values: { value: string; label: string }[]) {
  return values.length > 1 ? [{ value: '', label: all }, ...values] : null
}

type MoreProps = {
  catalog: VoiceCatalogData | undefined
  /** The catalog's voices, each once (oncePerVoice). */
  voices: readonly PickerVoice[]
  /** The assistant's main language and the others it speaks: the order, the rows' language line and the filter. */
  main: string
  others: readonly string[]
  assistantName: string
  error: string | null
  onRetry: () => unknown
  selected: string
  onPick: (voice: PickerVoice) => void
  disabled: boolean
  preview: Preview
  /**
   * The language filter it opens on (and goes back to when the assistant's languages change): the assistant's languages
   * (ASSISTANT_LANGUAGES, the default), or '' for every language (the realtime voices, which are all native English).
   */
  openOn?: string
}

/**
 * Every voice of every provider with a key: search, filters, preview, pick. Opens on the assistant's languages, voices
 * native in the main language first; "All languages" shows every voice.
 */
export function MoreVoices({
  catalog,
  voices: listed,
  main,
  others,
  assistantName,
  error,
  onRetry,
  selected,
  onPick,
  disabled,
  preview,
  openOn = ASSISTANT_LANGUAGES,
}: MoreProps) {
  const t = useT()
  const [filter, setFilter] = useState<VoiceFilter>({ ...ASSISTANT_FILTER, language: openOn })
  const [shown, setShown] = useState(PAGE)
  const set = (change: Partial<VoiceFilter>) => {
    setFilter(f => ({ ...f, ...change }))
    setShown(PAGE)
  }
  // New languages for the assistant: the language filter goes back to them, nothing of the languages before stays.
  const languagesKey = [main, ...others].join(',')
  const [filterFor, setFilterFor] = useState(languagesKey)
  if (filterFor !== languagesKey) {
    setFilterFor(languagesKey)
    set({ language: openOn })
  }
  const voices = useMemo(() => [...listed].sort(byLanguageFit(main, others)), [listed, main, others])
  const configured = (catalog?.providers ?? []).filter(p => p.configured)
  const labelOf = (provider: string) => configured.find(p => p.provider === provider)?.label
  const matches = useMemo(() => filterVoices(voices, filter, main, others), [voices, filter, main, others])
  if (!catalog)
    return (
      <Loading
        what={t('settings.voice.loadWhat')}
        loading
        error={error}
        onRetry={onRetry}
        skeleton={
          <div className="vp-more-body">
            <Skeleton shape="field" width="100%" />
            <SkeletonList rows={4} lead={16} />
          </div>
        }
      />
    )
  const failed = catalog.providers.filter(p => p.error)
  // No voice to show because a provider's list could not be read: one problem with Try again, not "No voices yet".
  if (!voices.length && failed.length)
    return (
      <div className="vp-more-body">
        <CatalogProblem failed={failed} onRetry={onRetry} />
        <ProviderHints providers={catalog.providers} />
      </div>
    )
  const filters = [
    {
      key: 'provider' as const,
      label: t('settings.voice.filter.provider'),
      options: filterOptions(
        t('settings.voice.filter.allProviders'),
        configured.map(p => ({ value: p.provider, label: p.label })),
      ),
    },
    {
      key: 'language' as const,
      label: t('common.language.label'),
      options: [
        {
          value: ASSISTANT_LANGUAGES,
          label: others.length
            ? t('settings.voice.filter.assistantLanguages', { name: assistantName })
            : languageName(main),
        },
        { value: '', label: t('settings.voice.filter.allLanguages') },
        ...facetValues(voices, 'language'),
      ],
    },
    {
      key: 'gender' as const,
      label: t('settings.voice.filter.gender'),
      options: filterOptions(t('settings.voice.filter.anyGender'), facetValues(voices, 'gender')),
    },
    {
      key: 'accent' as const,
      label: t('settings.voice.filter.accent'),
      options: filterOptions(t('settings.voice.filter.anyAccent'), facetValues(voices, 'accent')),
    },
  ]
  return (
    <div className="vp-more-body">
      <div className="vp-tools">
        <span className="vp-search">
          <Icon name="search" size={14} />
          <TextInput
            id="vp-search"
            size="sm"
            label={t('settings.voice.search')}
            placeholder={t('settings.voice.search')}
            value={filter.query}
            onChange={query => set({ query })}
          />
        </span>
        {filters.map(
          f =>
            f.options && (
              <Select
                key={f.key}
                size="sm"
                label={f.label}
                value={filter[f.key]}
                options={f.options}
                onChange={value => set({ [f.key]: value })}
              />
            ),
        )}
        {filter.language === ASSISTANT_LANGUAGES && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => set({ language: '' })}
            title={t('settings.voice.showAllLanguagesTip')}
          >
            {t('settings.voice.showAllLanguages')}
          </Button>
        )}
      </div>
      {matches.length ? (
        <div className="vp-list" role="radiogroup" aria-label={t('settings.voice.more')}>
          {matches.slice(0, shown).map(v => (
            <VoiceRow
              key={voiceKey(v.provider, v.id)}
              voice={v}
              checked={selected === voiceKey(v.provider, v.id)}
              onPick={() => onPick(v)}
              disabled={disabled}
              preview={preview}
              facts={voiceFacts(v, main, others, configured.length > 1 ? labelOf(v.provider) : undefined)}
            />
          ))}
        </div>
      ) : (
        <p className="help">{voices.length ? t('settings.voice.noMatch') : t('settings.voice.none')}</p>
      )}
      {matches.length > shown && (
        <Button size="sm" variant="ghost" onClick={() => setShown(n => n + PAGE)}>
          {t('settings.voice.showMore', {
            count: Math.min(PAGE, matches.length - shown),
            rest: matches.length - shown,
          })}
        </Button>
      )}
      {failed.length > 0 && <CatalogProblem failed={failed} onRetry={onRetry} inline />}
      <ProviderHints providers={catalog.providers} />
    </div>
  )
}

/** The reason a provider's list could not be read; an older API sent English text, which is never shown. */
const failureOf = (p: CatalogProvider): ProviderFailureReason =>
  (providerFailureReasons as readonly (string | null)[]).includes(p.error)
    ? (p.error as ProviderFailureReason)
    : 'unknown'

/**
 * Providers whose voice list could not be read: what went wrong and the next step, worded for the reader (an instance
 * admin is pointed to Server admin › Providers, anyone else to whoever runs the server), with Try again. `inline` under
 * a list that still has other providers' voices; otherwise it stands in for the list.
 */
function CatalogProblem({
  failed,
  onRetry,
  inline = false,
}: {
  failed: readonly CatalogProvider[]
  onRetry: () => unknown
  inline?: boolean
}) {
  const t = useT()
  const [retrying, setRetrying] = useState(false)
  const audience = providerAudience()
  const retry = async () => {
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }
  const reasons = failed.map(p => providerFailureText(failureOf(p), p.label, audience, i18n()))
  // Under other providers' voices it is a quiet line; standing in for the list it is announced.
  return (
    <div className="vp-problem" role={inline ? 'status' : 'alert'}>
      <p className="help">{reasons.join(' ')}</p>
      <Button size="sm" variant={inline ? 'ghost' : undefined} onClick={() => void retry()} disabled={retrying}>
        {t('common.action.tryAgain')}
      </Button>
    </div>
  )
}

/** Server admins only: the providers without a key, whose voices would show here once they have one. */
function ProviderHints({ providers }: { providers: readonly CatalogProvider[] }) {
  const format = useFormat()
  const missing = providers.filter(p => !p.configured).map(p => p.label)
  if (providerAudience() !== 'admin' || !missing.length) return null
  return (
    <p className="help">
      <T
        k="settings.voice.providersMissing"
        values={{
          providers: format.list(missing),
          count: missing.length,
          link: adminLink('#admin/providers/answering'),
        }}
      />
    </p>
  )
}

type Props = {
  assistantId: string
  voice: { provider: string; voice_id: string }
  onPick: (voice: { provider: string; voice_id: string }) => void
  canEdit: boolean
  toast: (text: string) => void
  /** The assistant's main language: Suggested lists voices made for it when the providers have some. */
  language: string
  /** The languages besides the main one the assistant speaks (otherLanguagesOf): ranked after the main language. */
  otherLanguages: readonly string[]
  /** The assistant's name, for the line under the default voice ("Maya speaks with it unless you pick another"). */
  assistantName: string
  /**
   * Onboarding: an assistant without a voice of its own takes its main language's default voice (languageDefaultVoices)
   * as a pick, so it is saved with the step and the test call speaks with it. Elsewhere the default stays '' (calls
   * speak with that voice anyway).
   */
  adoptLanguageDefault?: boolean
}

/** How long the notice of a voice switched for the languages stays, with its Undo. */
const FOLLOWED_NOTICE_MS = 10_000

/** How many voices Suggested lists for a main language other than English. */
const SUGGESTED_FOR_LANGUAGE = 6

function CloneVoice({
  assistantId,
  toast,
  disabled,
}: {
  assistantId: string
  toast: Props['toast']
  disabled: boolean
}) {
  const t = useT()
  const write = useWriteAction()
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const problem = cloneProblem({ name, file, consent })
  async function clone() {
    setTried(true)
    if (problem || !file) return
    setBusy(true)
    try {
      const audio = await fileToBase64(file)
      await write<VoiceCloneData>('voice.clone', {
        assistantId,
        name: name.trim(),
        consent: true,
        audio,
        mimeType: file.type,
      })
      void refreshQuery(VOICE_OPTIONS) // the new voice is in the list at once, not at the next focus
      toast(t('settings.voice.clone.done', { name: name.trim() }))
      setName('')
      setFile(null)
      setConsent(false)
      setTried(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : t('settings.voice.clone.failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="vc-clone">
      <summary>{t('settings.voice.clone.title')}</summary>
      <Field id="vc-clone-name" label={t('settings.voice.clone.name')}>
        <TextInput
          id="vc-clone-name"
          value={name}
          onChange={setName}
          placeholder={t('settings.voice.clone.namePlaceholder')}
        />
      </Field>
      <Field
        id="vc-clone-file"
        label={t('settings.voice.clone.recording')}
        help={t('settings.voice.clone.recordingHelp')}
      >
        <input id="vc-clone-file" type="file" accept="audio/*" onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Checkbox checked={consent} onChange={setConsent}>
        {CLONE_CONSENT_TEXT}
      </Checkbox>
      {tried && problem && <FormMessage>{problem}</FormMessage>}
      <div className="vc-actions">
        <Button
          busy={busy}
          size="sm"
          disabled={disabled || busy}
          onClick={() => void clone()}
          title={t('settings.voice.clone.buttonTip')}
        >
          {busy ? t('settings.voice.clone.busy') : t('settings.voice.clone.button')}
        </Button>
        <span className="help">{t('settings.voice.clone.notKept')}</span>
      </div>
    </details>
  )
}

export function VoiceSettings({
  assistantId,
  voice,
  onPick,
  canEdit,
  toast,
  language,
  otherLanguages,
  assistantName,
  adoptLanguageDefault = false,
}: Props) {
  const t = useT()
  const { data: options } = useVoiceOptions()
  const provider = options?.provider ?? null
  const preview = usePreview(provider, language)
  const [moreOpen, setMoreOpen] = useState(false)
  const clones: PickerVoice[] = provider
    ? (options?.clones ?? []).map(v => ({ provider, id: v.id, name: v.name, description: t('settings.voice.cloned') }))
    : []
  const curated: PickerVoice[] = provider ? (options?.voices ?? []).map(v => ({ provider, ...v })) : []
  const isCurated = [...curated, ...clones].some(v => v.provider === voice.provider && v.id === voice.voice_id)
  // The assistant's languages changed since the last look: the voice may have to follow them (below).
  const languagesKey = [language, ...otherLanguages].join(',')
  const [seenLanguages, setSeenLanguages] = useState(languagesKey)
  const [follow, setFollow] = useState(false)
  if (seenLanguages !== languagesKey) {
    setSeenLanguages(languagesKey)
    setFollow(true)
  }
  /** The last switch made for the languages, with Undo, for a few seconds. */
  const [followed, setFollowed] = useState<(FollowedVoice & { from: { provider: string; voice_id: string } }) | null>(
    null,
  )
  useEffect(() => {
    if (!followed) return
    const timer = setTimeout(() => setFollowed(null), FOLLOWED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [followed])
  // The catalog is read when More voices opens, for languages besides English alone (their voices are suggested), when
  // the voice in use is one of it, or to follow a change of the languages.
  const forOtherLanguage = language !== 'en' || otherLanguages.some(code => code !== 'en')
  const needCatalog = moreOpen || follow || forOtherLanguage || (!!voice.voice_id && !!options && !isCurated)
  const {
    data: catalog,
    error: catalogError,
    reload: reloadCatalog,
  } = useQuery(needCatalog ? VOICE_CATALOG : null, loadCatalog, {
    persist: true,
  })
  // Each voice once: a catalog kept from an older API lists a library voice once per language it is verified in.
  const catalogVoices = useMemo(() => oncePerVoice(catalog?.voices ?? []), [catalog])
  // A suggested voice as the provider's list describes it (its languages), where the list has it.
  const described = (v: PickerVoice): PickerVoice =>
    catalogVoices.find(c => c.provider === v.provider && c.id === v.id) ?? v
  // The main language's own default voice (languageDefaultVoices): what calls speak with when the assistant picked none.
  const usableDefault = usableLanguageDefault(provider, language, catalog, catalogVoices)
  // Another main language: the voices native in it first (suggestedForLanguage), its default voice on top, else the
  // curated ones, each saying its accent, with a note why there is no native voice.
  const forLanguage =
    (catalog &&
      suggestedForLanguage(
        catalogVoices,
        curated,
        language,
        otherLanguages,
        provider,
        SUGGESTED_FOR_LANGUAGE,
        usableDefault,
      )) ||
    []
  const nativeNote =
    catalog && !forLanguage.length
      ? missingNativeNote(
          language,
          catalog.providers.find(p => p.active),
        )
      : null
  const configuredProviders = catalog?.providers.filter(p => p.configured) ?? []
  const coverage =
    catalog && forLanguage.length
      ? coverageNote(
          oncePerVoice([...catalogVoices, ...curated]),
          language,
          otherLanguages,
          configuredProviders.length === 1 ? configuredProviders[0]!.label : null,
        )
      : null
  // Suggested for another language comes from the providers' list: until it is read, grey rows, never the English
  // voices that turn into the native ones when it comes (design-principles.md, 15). Not read: the curated ones.
  const suggestedLoading = forOtherLanguage && !catalog && !catalogError
  const suggested = [...(forLanguage.length ? forLanguage : curated.map(described)), ...clones.map(described)]
  const isSuggested = suggested.some(v => v.provider === voice.provider && v.id === voice.voice_id)
  const usable = catalog
    ? catalog.providers.filter(p => p.configured).map(p => p.provider)
    : [provider, voice.provider].filter((p): p is string => !!p)
  const current = voiceInEffect(voice, usable)
  // The default row already stands for the install's default voice: don't list that voice again under it,
  // unless it was picked by name (then its own row is the checked one).
  const defaultKey =
    !forLanguage.length && provider && options?.defaultVoice ? voiceKey(provider, options.defaultVoice.id) : null
  const listed =
    defaultKey && current !== defaultKey ? suggested.filter(v => voiceKey(v.provider, v.id) !== defaultKey) : suggested
  // For another language there is no default row: the language's default voice (else the install's default voice),
  // when it is listed, is the checked one while the assistant has none of its own ('' is the default voice).
  const installDefaultKey = usableDefault
    ? voiceKey(usableDefault.provider, usableDefault.id)
    : provider && options?.defaultVoice
      ? voiceKey(provider, options.defaultVoice.id)
      : null
  const isChecked = (v: PickerVoice) =>
    current === voiceKey(v.provider, v.id) ||
    (current === '' && forLanguage.length > 0 && voiceKey(v.provider, v.id) === installDefaultKey)
  const fromCatalog =
    current && !isSuggested
      ? (catalogVoices.find(v => voiceKey(v.provider, v.id) === current) ?? {
          provider: voice.provider,
          id: voice.voice_id,
          name: t('settings.voice.chosen'),
          description: voice.voice_id,
        })
      : null
  // The voice "Default voice" stands for, with its languages where they are known: the language's own for another
  // language (calls speak with it, defaultVoiceFor).
  const defaultVoice = usableDefault
    ? usableDefault
    : provider && options?.defaultVoice
      ? described(
          curated.find(v => v.id === options.defaultVoice?.id) ?? {
            provider,
            id: options.defaultVoice.id,
            name: options.defaultVoice.name ?? t('settings.voice.default'),
            description: null,
          },
        )
      : null
  const pick = (v: PickerVoice | null) => {
    setFollowed(null)
    if (v) onPick({ provider: v.provider, voice_id: v.id })
    else if (provider) onPick({ provider, voice_id: '' })
  }
  const failure = preview.failed
  // The assistant's languages decide the voice: after they change, a voice that can't perform all of them is switched
  // to the one that performs the most (followLanguages), with a notice and Undo. A voice that still does stays.
  useEffect(() => {
    if (!follow || !catalog || !options) return
    setFollow(false)
    if (!canEdit) return
    const inEffect = current ? voice : { provider: provider ?? voice.provider, voice_id: '' }
    const next = followLanguages({
      voices: catalogVoices,
      curated: curated.map(described),
      defaultVoice,
      current: inEffect,
      main: language,
      others: otherLanguages,
    })
    if (!next) return setFollowed(null)
    onPick(next.voice)
    setFollowed({ ...next, from: voice })
  })
  // Onboarding: no voice of its own yet, and the main language has a default voice: that one is picked (and saved with
  // the step), so the test call speaks with the voice shown checked.
  useEffect(() => {
    const adopted = adoptLanguageDefault && canEdit ? languageDefaultPick(voice, usableDefault) : null
    if (adopted) onPick(adopted)
  })

  if (options && !provider)
    return (
      <Section id="as-voice" title={t('settings.voice.title')}>
        <MissingProviderNote kind="voice" />
      </Section>
    )
  return (
    <Section id="as-voice" title={t('settings.voice.title')} help={t('settings.voice.help')}>
      <div className="vp-group-label" id="vp-suggested">
        {t('settings.voice.suggested')}
      </div>
      {suggestedLoading ? (
        <VoiceRowsSkeleton rows={Math.min(SUGGESTED_FOR_LANGUAGE, Math.max(curated.length, VOICE_SKELETON_ROWS))} />
      ) : (
        <div className="vp-list" role="radiogroup" aria-labelledby="vp-suggested">
          {fromCatalog && (
            <VoiceRow
              voice={fromCatalog}
              checked
              onPick={() => pick(fromCatalog)}
              disabled={!canEdit}
              preview={preview}
              facts={voiceFacts(
                fromCatalog,
                language,
                otherLanguages,
                catalog?.providers.find(p => p.provider === fromCatalog.provider)?.label,
              )}
            />
          )}
          {/* The default voice speaks English: offered for English, and for a language the providers have no voices for. */}
          {!forLanguage.length && (
            <VoiceRow
              voice={null}
              defaultNote={t('settings.voice.defaultNote', { name: assistantName })}
              defaultSample={provider && options?.defaultVoice ? { provider, ...options.defaultVoice } : null}
              checked={current === ''}
              onPick={() => pick(null)}
              disabled={!canEdit}
              preview={preview}
              facts={(defaultVoice && languageLabel(defaultVoice, language, otherLanguages)) || undefined}
            />
          )}
          {listed.map(v => (
            <VoiceRow
              key={voiceKey(v.provider, v.id)}
              voice={v}
              checked={isChecked(v)}
              onPick={() => pick(v)}
              disabled={!canEdit}
              preview={preview}
              facts={
                (forLanguage.includes(v)
                  ? voiceFacts(v, language, otherLanguages)
                  : languageLabel(v, language, otherLanguages)) || undefined
              }
            />
          ))}
        </div>
      )}
      {followed && (
        <p className="help vp-followed" role="status">
          {followedNotice(followed)}{' '}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onPick(followed.from)
              setFollowed(null)
            }}
          >
            {t('common.action.undo')}
          </Button>
        </p>
      )}
      {coverage && <p className="help vp-native-note">{coverage}</p>}
      {nativeNote && (
        <p className="help vp-native-note">
          {nativeNote.text} <HelpTip label={t('settings.voice.native.why')} text={nativeNote.help} />
        </p>
      )}
      {failure && <FormMessage>{failure.message}</FormMessage>}
      <details className="vp-more" onToggle={e => setMoreOpen(e.currentTarget.open)}>
        <summary title={t('settings.voice.moreTip')}>
          <Icon name="down" size={14} className="vp-chevron" />
          {t('settings.voice.more')}
        </summary>
        {moreOpen && (
          <MoreVoices
            catalog={catalog}
            voices={catalogVoices}
            main={language}
            others={otherLanguages}
            assistantName={assistantName}
            error={catalogError}
            onRetry={reloadCatalog}
            selected={current}
            onPick={pick}
            disabled={!canEdit}
            preview={preview}
          />
        )}
      </details>
      {options?.canClone && <CloneVoice assistantId={assistantId} toast={toast} disabled={!canEdit} />}
    </Section>
  )
}

/** Suggested voice rows while the voice options load: the rows' own classes, so the same heights (VoiceRow). */
function VoiceRowsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="vp-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows never reorder
        <div key={i} className="vp-row">
          <span className="vp-pick">
            <Skeleton width={16} height={16} className="sk-round" />
            <span className="vp-text">
              <span className="vp-name">
                <Skeleton shape="text" width={90 + ((i * 37) % 50)} />
              </span>
              <span className="vp-desc">
                <Skeleton shape="text" width={180 + ((i * 53) % 90)} />
              </span>
            </span>
          </span>
          <Skeleton width={30} height={30} className="sk-round" />
        </div>
      ))}
    </div>
  )
}

/**
 * The Voice card until the voice options are read (voice.options). They decide which card comes, the realtime
 * model's voices or the voice providers' (and which rows it lists): until then the card shows its words that don't
 * need the data and grey rows, never a default voice that changes when the data comes (design-principles.md, 15).
 */
export function VoiceLoading({ children }: { children: ReactNode }) {
  const t = useT()
  const { data, error, reload } = useVoiceOptions()
  if (data) return children
  return (
    <Section id="as-voice" title={t('settings.voice.title')}>
      <Loading
        what={t('settings.voice.loadWhat')}
        loading
        error={error}
        onRetry={() => void reload()}
        className="vp-loading"
        skeleton={
          <>
            <div className="vp-group-label">{t('settings.voice.suggested')}</div>
            <VoiceRowsSkeleton rows={VOICE_SKELETON_ROWS} />
            <div className="vp-more">
              <span className="vp-more-sk">
                <Skeleton width={14} height={14} />
                <Skeleton shape="text" width={76} />
              </span>
            </div>
            <p className="help">
              <Skeleton shape="text" width={440} />
            </p>
          </>
        }
      />
    </Section>
  )
}

type RealtimeProps = {
  /** The assistant's realtime voice (`realtime_voice`); '' for the server's default voice. */
  voice: string
  onPick: (voice: string) => void
  canEdit: boolean
  language: string
  otherLanguages: readonly string[]
  assistantName: string
}

/** The realtime voices as More voices takes them: one provider, set up, in effect. */
const realtimeCatalog = (voices: readonly PickerVoice[]): VoiceCatalogData => ({
  providers: [
    {
      provider: REALTIME_VOICE_PROVIDER,
      label: providerSpec(REALTIME_VOICE_PROVIDER).label,
      active: true,
      configured: true,
      error: null,
    },
  ],
  voices: voices.map(v => ({ ...v, language: 'en', gender: null, accent: null })),
})

/**
 * Settings › Assistant › Voice while the realtime model answers the assistant's calls: the model's own voices
 * (realtimeVoices in @linedesk/actions) with the same rows, samples and More voices as the voice providers' picker.
 * Suggested: the default voice (marin, REALTIME_DEFAULT_VOICE) and the voices OpenAI recommends; More voices:
 * all of them. The pick is part of the page's draft (Save) and applies from the next call.
 */
export function RealtimeVoiceSettings({
  voice,
  onPick,
  canEdit,
  language,
  otherLanguages,
  assistantName,
}: RealtimeProps) {
  const t = useT()
  const { data: options } = useVoiceOptions()
  // Every sample names its provider (openai_realtime): never the voice provider in effect for the three stages.
  const preview = usePreview(null, language)
  const [moreOpen, setMoreOpen] = useState(false)
  const voices = useMemo(() => realtimePickerVoices(t('settings.voice.realtime.recommended')), [t])
  const catalog = useMemo(() => realtimeCatalog(voices), [voices])
  const defaultId = options?.realtimeDefaultVoice ?? REALTIME_DEFAULT_VOICE
  const defaultVoice = voices.find(v => v.id === defaultId) ?? null
  const current = voice ? voiceKey(REALTIME_VOICE_PROVIDER, voice) : ''
  const defaultKey = voiceKey(REALTIME_VOICE_PROVIDER, defaultId)
  const recommended = voices.filter(v => v.description)
  const picked = voices.find(v => voiceKey(v.provider, v.id) === current)
  // The default row stands for the default voice: not listed again unless it was picked by name.
  const suggested = [...recommended, ...(picked && !recommended.includes(picked) ? [picked] : [])].filter(
    v => current === defaultKey || voiceKey(v.provider, v.id) !== defaultKey,
  )
  const failure = preview.failed
  return (
    <Section id="as-voice" title={t('settings.assistant.realtimeVoice.title')} help={t('settings.voice.realtime.help')}>
      <div className="vp-group-label" id="vp-suggested">
        {t('settings.voice.suggested')}
      </div>
      <div className="vp-list" role="radiogroup" aria-labelledby="vp-suggested">
        <VoiceRow
          voice={null}
          defaultNote={t('settings.voice.defaultNote', { name: assistantName })}
          defaultSample={defaultVoice}
          checked={current === ''}
          onPick={() => onPick('')}
          disabled={!canEdit}
          preview={preview}
          facts={(defaultVoice && languageLabel(defaultVoice, language, otherLanguages)) || undefined}
        />
        {suggested.map(v => (
          <VoiceRow
            key={voiceKey(v.provider, v.id)}
            voice={v}
            checked={current === voiceKey(v.provider, v.id)}
            onPick={() => onPick(v.id)}
            disabled={!canEdit}
            preview={preview}
            facts={voiceFacts(v, language, otherLanguages)}
          />
        ))}
      </div>
      {failure && <FormMessage>{failure.message}</FormMessage>}
      <details className="vp-more" onToggle={e => setMoreOpen(e.currentTarget.open)}>
        <summary title={t('settings.voice.realtime.moreTip')}>
          <Icon name="down" size={14} className="vp-chevron" />
          {t('settings.voice.more')}
        </summary>
        {moreOpen && (
          <MoreVoices
            catalog={catalog}
            voices={voices}
            main={language}
            others={otherLanguages}
            assistantName={assistantName}
            error={null}
            onRetry={() => {}}
            selected={current}
            onPick={v => onPick(v.id)}
            disabled={!canEdit}
            preview={preview}
            openOn=""
          />
        )}
      </details>
      <p className="help">
        {t('settings.voice.quality.ultraVoices')}{' '}
        <T k="settings.assistant.realtimeVoice.body" values={{ link: adminLink('#admin/providers/answering') }} />
      </p>
    </Section>
  )
}
