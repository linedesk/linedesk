// The voice picker's rules, without React: which voice is in effect, what Save sends, the preview
// link, and the checks before a recording is sent to be cloned.
import { CLONE_AUDIO_MAX_BYTES, cloneAudioTypes } from '@linedesk/actions'

export type VoiceChoice = { provider: string; voice_id: string }

/** The voice id that applies with this provider: a voice picked for another provider does not (the agent ignores it too). */
export const voiceInEffect = (voice: VoiceChoice, provider: string | null): string =>
  provider && voice.provider === provider ? voice.voice_id : ''

/** The sample of a voice, made once on the server and cached by the browser too. */
export const previewUrl = (voiceId: string) => `/v1/voices/preview/${encodeURIComponent(voiceId)}`

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
