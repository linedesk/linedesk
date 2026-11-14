// Settings › Assistant › Voice: suggested voices (the curated ones and the workspace's clones) as
// compact rows with a play button, and More voices: every voice of every provider with a key, with
// search and filters. Cloning a voice where the provider can. The pick is part of the page's draft
// (Save); cloning saves at once, since the provider creates the voice right away.
import {
  CLONE_CONSENT_TEXT,
  type CatalogProvider,
  type VoiceCatalogData,
  type VoiceCloneData,
  type VoiceOptionsData,
} from '@linedesk/actions'
import { useEffect, useMemo, useRef, useState } from 'react'
import { refreshQuery, useQuery } from '../cachedQuery.ts'
import { workspaceHeaders } from '../tabWorkspace.ts'
import { Checkbox, Select } from '../ui/controls.tsx'
import { FormMessage } from '../ui/form.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import { Loading, Skeleton, SkeletonList } from '../ui/LoadStates.tsx'
import { Field, Section, TextInput } from './fields.tsx'
import { readAction, useWriteAction } from './settings-api.ts'
import {
  byEnglishThenName,
  cloneProblem,
  facetValues,
  fileToBase64,
  filterVoices,
  NO_FILTER,
  type PickerVoice,
  previewProblem,
  previewUrl,
  type VoiceFilter,
  voiceFacts,
  voiceInEffect,
  voiceKey,
  voicesForLanguage,
} from './voiceModel.ts'

const VOICE_OPTIONS = 'voice.options'
const VOICE_CATALOG = 'voice.catalog'
const loadOptions = () => readAction<VoiceOptionsData>(VOICE_OPTIONS)
/** Every voice of the providers with a key (voice.catalog); the server caches it a few minutes. */
export const loadCatalog = () => readAction<VoiceCatalogData>(VOICE_CATALOG)
/** The voices of the provider in effect; the same for every assistant of the install. */
export const useVoiceOptions = () => useQuery(VOICE_OPTIONS, loadOptions, { persist: true })
/** How many voices More voices shows at first, and adds per "Show more". */
const PAGE = 30

type PreviewFailure = { key: string; message: string }

/** The sample as a playable URL, or why there is none. Fetched first so a refusal can say why. */
async function loadPreview(key: string, voiceId: string, provider: string | null): Promise<string | PreviewFailure> {
  const res = await fetch(previewUrl(voiceId, provider), { credentials: 'include', headers: workspaceHeaders() }).catch(
    () => null,
  )
  if (!res?.ok || !res.headers.get('content-type')?.startsWith('audio/')) {
    const body = (await res?.json().catch(() => null)) as { error?: string; message?: string } | null
    return { key, message: previewProblem(res?.status ?? 0, body?.error, body?.message) }
  }
  return URL.createObjectURL(await res.blob())
}

/**
 * One preview at a time: playing another stops the first. A sample is fetched once per page view.
 * `progress` (0–1) of the one playing, for its ring.
 */
function usePreview(activeProvider: string | null) {
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
    let url = loaded.current.get(key)
    if (!url) {
      setLoading(key)
      const result = await loadPreview(key, voice.id, voice.provider === activeProvider ? null : voice.provider)
      if (typeof result === 'string') loaded.current.set(key, result)
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
      setFailed({ key, message: 'The sample could not be played.' })
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
  const name = label ?? voice?.name ?? ''
  if (!voice)
    return (
      // aria-disabled, not disabled: a disabled button gets no hover, so its tooltip would never show.
      <button
        type="button"
        className="vp-play is-off"
        aria-disabled="true"
        aria-label={`Play ${name}`}
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
      aria-label={`${busy ? 'Stop' : 'Play'} ${name}`}
      aria-busy={loading || undefined}
      title={busy ? `Stop the sample of ${name}` : `Play a sample of ${name}`}
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
  const defaultName = defaultSample?.name ? `${defaultSample.name} (default)` : 'Default voice'
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
          unavailable="No default voice to play: the voice provider in use has none set (Admin › Providers)"
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
  error: string | null
  onRetry: () => void
  selected: string
  onPick: (voice: PickerVoice) => void
  disabled: boolean
  preview: Preview
}

/** Every voice of every provider with a key: search, filters, preview, pick. */
function MoreVoices({ catalog, error, onRetry, selected, onPick, disabled, preview }: MoreProps) {
  const [filter, setFilter] = useState<VoiceFilter>(NO_FILTER)
  const [shown, setShown] = useState(PAGE)
  const set = (change: Partial<VoiceFilter>) => {
    setFilter(f => ({ ...f, ...change }))
    setShown(PAGE)
  }
  const voices = useMemo(() => [...(catalog?.voices ?? [])].sort(byEnglishThenName), [catalog])
  const configured = (catalog?.providers ?? []).filter(p => p.configured)
  const labelOf = (provider: string) => configured.find(p => p.provider === provider)?.label
  const matches = useMemo(() => filterVoices(voices, filter), [voices, filter])
  if (!catalog)
    return (
      <Loading
        what="The voices"
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
  const filters = [
    {
      key: 'provider' as const,
      label: 'Provider',
      options: filterOptions(
        'All providers',
        configured.map(p => ({ value: p.provider, label: p.label })),
      ),
    },
    {
      key: 'language' as const,
      label: 'Language',
      options: filterOptions('Any language', facetValues(voices, 'language')),
    },
    { key: 'gender' as const, label: 'Gender', options: filterOptions('Any gender', facetValues(voices, 'gender')) },
    { key: 'accent' as const, label: 'Accent', options: filterOptions('Any accent', facetValues(voices, 'accent')) },
  ]
  return (
    <div className="vp-more-body">
      <div className="vp-tools">
        <span className="vp-search">
          <Icon name="search" size={14} />
          <TextInput
            id="vp-search"
            label="Search voices"
            placeholder="Search voices"
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
      </div>
      {matches.length ? (
        <div className="vp-list" role="radiogroup" aria-label="More voices">
          {matches.slice(0, shown).map(v => (
            <VoiceRow
              key={voiceKey(v.provider, v.id)}
              voice={v}
              checked={selected === voiceKey(v.provider, v.id)}
              onPick={() => onPick(v)}
              disabled={disabled}
              preview={preview}
              facts={voiceFacts(v, configured.length > 1 ? labelOf(v.provider) : undefined)}
            />
          ))}
        </div>
      ) : (
        <p className="help">{voices.length ? 'No voice matches.' : 'No voices yet.'}</p>
      )}
      {matches.length > shown && (
        <Button size="sm" variant="ghost" onClick={() => setShown(n => n + PAGE)}>
          Show {Math.min(PAGE, matches.length - shown)} more of {matches.length - shown}
        </Button>
      )}
      <ProviderHints providers={catalog.providers} />
    </div>
  )
}

/** A line per provider whose voices are missing: no key, or the list could not be read. */
function ProviderHints({ providers }: { providers: readonly CatalogProvider[] }) {
  const missing = providers.filter(p => !p.configured).map(p => p.label)
  const failed = providers.filter(p => p.error)
  return (
    <>
      {failed.map(p => (
        <FormMessage key={p.provider}>{p.error}</FormMessage>
      ))}
      {missing.length > 0 && (
        <p className="help">
          {missing.join(' and ')} voices show here once {missing.length > 1 ? 'they have' : 'it has'} a key (Admin ›
          Providers).
        </p>
      )}
    </>
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
  /** The assistant's name, for the line under the default voice ("Maya speaks with it unless you pick another"). */
  assistantName: string
}

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
      toast(`Cloned "${name.trim()}". It is the assistant's voice now.`)
      setName('')
      setFile(null)
      setConsent(false)
      setTried(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The voice could not be cloned.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="vc-clone">
      <summary>Clone a voice</summary>
      <Field id="vc-clone-name" label="Name">
        <TextInput id="vc-clone-name" value={name} onChange={setName} placeholder="Mike's voice" />
      </Field>
      <Field id="vc-clone-file" label="Recording" help="1–2 minutes of clear speech, at most 10 MB.">
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
          title="Send the recording to the voice provider and use the new voice"
        >
          {busy ? 'Cloning…' : 'Clone voice'}
        </Button>
        <span className="help">Sent to the voice provider, not kept.</span>
      </div>
    </details>
  )
}

export function VoiceSettings({ assistantId, voice, onPick, canEdit, toast, language, assistantName }: Props) {
  const { data: options } = useVoiceOptions()
  const provider = options?.provider ?? null
  const preview = usePreview(provider)
  const [moreOpen, setMoreOpen] = useState(false)
  const clones: PickerVoice[] = provider
    ? (options?.clones ?? []).map(v => ({ provider, id: v.id, name: v.name, description: 'Your cloned voice' }))
    : []
  const curated: PickerVoice[] = provider ? (options?.voices ?? []).map(v => ({ provider, ...v })) : []
  const isCurated = [...curated, ...clones].some(v => v.provider === voice.provider && v.id === voice.voice_id)
  // The catalog is read when More voices opens, for a main language other than English (its voices are suggested),
  // or at once when the voice in use is one of it.
  const needCatalog = moreOpen || language !== 'en' || (!!voice.voice_id && !!options && !isCurated)
  const {
    data: catalog,
    error: catalogError,
    reload: reloadCatalog,
  } = useQuery(needCatalog ? VOICE_CATALOG : null, loadCatalog, {
    persist: true,
  })
  // Another main language: the providers' voices made for it, else the curated (English) ones.
  const forLanguage =
    language !== 'en' && catalog
      ? voicesForLanguage(catalog.voices, language, provider).slice(0, SUGGESTED_FOR_LANGUAGE)
      : []
  const suggested = [...(forLanguage.length ? forLanguage : curated), ...clones]
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
  const fromCatalog =
    current && !isSuggested
      ? (catalog?.voices.find(v => voiceKey(v.provider, v.id) === current) ?? {
          provider: voice.provider,
          id: voice.voice_id,
          name: 'Chosen voice',
          description: voice.voice_id,
        })
      : null
  const pick = (v: PickerVoice | null) =>
    v ? onPick({ provider: v.provider, voice_id: v.id }) : provider && onPick({ provider, voice_id: '' })
  const failure = preview.failed

  if (options && !provider)
    return (
      <Section id="as-voice" title="Voice">
        <span className="help">No voice provider yet (Admin, Providers).</span>
      </Section>
    )
  return (
    <Section
      id="as-voice"
      title="Voice"
      help="Applies from the next call. Play a sample to hear how a voice sounds on the phone."
    >
      <div className="vp-group-label" id="vp-suggested">
        Suggested
      </div>
      <div className="vp-list" role="radiogroup" aria-labelledby="vp-suggested">
        {fromCatalog && (
          <VoiceRow
            voice={fromCatalog}
            checked
            onPick={() => pick(fromCatalog)}
            disabled={!canEdit}
            preview={preview}
            facts={voiceFacts(fromCatalog, catalog?.providers.find(p => p.provider === fromCatalog.provider)?.label)}
          />
        )}
        {/* The default voice speaks English: offered for English, and for a language the providers have no voices for. */}
        {!forLanguage.length && (
          <VoiceRow
            voice={null}
            defaultNote={`${assistantName} speaks with it unless you pick another.`}
            defaultSample={provider && options?.defaultVoice ? { provider, ...options.defaultVoice } : null}
            checked={current === ''}
            onPick={() => pick(null)}
            disabled={!canEdit}
            preview={preview}
          />
        )}
        {listed.map(v => (
          <VoiceRow
            key={voiceKey(v.provider, v.id)}
            voice={v}
            checked={current === voiceKey(v.provider, v.id)}
            onPick={() => pick(v)}
            disabled={!canEdit}
            preview={preview}
            facts={forLanguage.includes(v) ? voiceFacts(v) : undefined}
          />
        ))}
      </div>
      {failure && <FormMessage>{failure.message}</FormMessage>}
      <details className="vp-more" onToggle={e => setMoreOpen(e.currentTarget.open)}>
        <summary title="Every voice of your voice providers, with search and filters">
          <Icon name="down" size={14} className="vp-chevron" />
          More voices
        </summary>
        {moreOpen && (
          <MoreVoices
            catalog={catalog}
            error={catalogError}
            onRetry={() => void reloadCatalog()}
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
