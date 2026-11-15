/** Asks for the microphone before anything is created, so a refusal costs nothing; the reason when it is not allowed. */
import { i18n } from '../i18n/index.tsx'
export async function microphoneAllowed(): Promise<string | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
    return null
  } catch (e) {
    return e instanceof DOMException && e.name === 'NotAllowedError'
      ? i18n().t('call.live.micBlocked')
      : i18n().t('call.live.noMic')
  }
}
