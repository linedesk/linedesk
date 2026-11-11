/** Asks for the microphone before anything is created, so a refusal costs nothing; the reason when it is not allowed. */
export async function microphoneAllowed(): Promise<string | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
    return null
  } catch (e) {
    return e instanceof DOMException && e.name === 'NotAllowedError'
      ? 'Microphone access is blocked. Allow it for this site, then try again.'
      : 'No microphone found. Connect one, then try again.'
  }
}
