// The voice picker's rules, without React: which voice is in effect, what Save sends, the preview
// link, and the checks before a recording is sent to be cloned.
import { CLONE_AUDIO_MAX_BYTES, cloneAudioTypes } from '@linedesk/actions'

export type VoiceChoice = { provider: string; voice_id: string }

/** One voice as the picker lists it, curated or from a provider's list. */
export type PickerVoice = {
  provider: string
  id: string
  name: string
  description: string | null
  language?: string | null
  gender?: string | null
  accent?: string | null
}

/** A voice's identity in the picker: the same id can exist at two providers. */
export const voiceKey = (provider: string, voiceId: string) => `${provider}:${voiceId}`

/**
 * The voice that applies, as a voiceKey ('' for the default): a voice of a provider that is not set
 * up (no key) does not apply; the agent uses the default voice then, so the picker shows that.
 */
export const voiceInEffect = (voice: VoiceChoice, usable: readonly string[]): string =>
  voice.voice_id && usable.includes(voice.provider) ? voiceKey(voice.provider, voice.voice_id) : ''

/**
 * The sample of a voice, made once on the server and cached by the browser too. `provider` only when
 * it is not the one in effect.
 */
export const previewUrl = (voiceId: string, provider?: string | null) =>
  `/v1/voices/preview/${encodeURIComponent(voiceId)}${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`

export type VoiceFilter = { query: string; provider: string; language: string; gender: string; accent: string }
export const NO_FILTER: VoiceFilter = { query: '', provider: '', language: '', gender: '', accent: '' }

const norm = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

/** The voices that match the search (name, description, accent) and every filter that is set. */
export function filterVoices<V extends PickerVoice>(voices: readonly V[], filter: VoiceFilter): V[] {
  const words = norm(filter.query).split(/\s+/).filter(Boolean)
  return voices.filter(v => {
    if (filter.provider && v.provider !== filter.provider) return false
    if (filter.language && norm(v.language) !== filter.language) return false
    if (filter.gender && norm(v.gender) !== filter.gender) return false
    if (filter.accent && norm(v.accent) !== filter.accent) return false
    const text = `${norm(v.name)} ${norm(v.description)} ${norm(v.accent)} ${norm(languageName(v.language))}`
    return words.every(w => text.includes(w))
  })
}

/** English first (the assistant speaks US English), then by name. */
export const byEnglishThenName = (a: PickerVoice, b: PickerVoice) =>
  Number(norm(a.language) !== 'en') - Number(norm(b.language) !== 'en') || a.name.localeCompare(b.name)

/** The values a filter can take in this list, sorted by label, each once. */
export function facetValues(voices: readonly PickerVoice[], field: 'language' | 'gender' | 'accent') {
  const values = new Set(voices.map(v => norm(v[field])).filter(Boolean))
  const label = field === 'language' ? languageName : capitalize
  return [...values].map(value => ({ value, label: label(value) })).sort((a, b) => a.label.localeCompare(b.label))
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
let languageNames: Intl.DisplayNames | null = null

/** "en" → "English"; an unknown code stays as it is. */
export function languageName(code: string | null | undefined): string {
  if (!code) return ''
  try {
    languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' })
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}

/** The muted facts after a voice's name: "Female · American · English", the provider when there are several. */
export function voiceFacts(v: PickerVoice, providerLabel?: string): string {
  return [v.gender && capitalize(v.gender), v.accent && capitalize(v.accent), languageName(v.language), providerLabel]
    .filter(Boolean)
    .join(' · ')
}

/**
 * What to say when a sample does not come back as audio: from the answer's status and the server's
 * error text (`status` 0: no answer at all).
 */
export function previewProblem(status: number, serverError?: string): string {
  if (status === 0) return 'No connection to the server. Try again.'
  if (status === 401) return 'You were signed out. Sign in again to hear samples.'
  if (status === 409) return 'Add a voice provider key in Admin › Providers to hear samples.'
  if (status === 429) return 'Too many new samples this hour. Try again later.'
  if (status === 404) return 'The voice provider does not know this voice.'
  if (status === 403 && serverError) return serverError
  return 'The voice provider did not answer. Try again.'
}

const MB = 1024 * 1024

/** Why this recording cannot be cloned, or null. */
export function cloneProblem(input: {
  name: string
  file: { size: number; type: string } | null
  consent: boolean
}): string | null {
  if (!input.name.trim()) return 'Give the voice a name.'
  if (!input.file) return 'Choose a recording of the voice: one to two minutes of clear speech.'
  if (!(cloneAudioTypes as readonly string[]).includes(input.file.type))
    return 'Use an MP3, WAV, M4A, WebM or OGG recording.'
  if (input.file.size > CLONE_AUDIO_MAX_BYTES)
    return `The recording is ${(input.file.size / MB).toFixed(1)} MB; at most 10 MB.`
  if (!input.consent) return 'Confirm that the speaker agreed to their voice being cloned.'
  return null
}

/** A file's bytes as base64, the way voice.clone takes the recording. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
