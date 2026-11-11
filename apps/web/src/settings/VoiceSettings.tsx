// Settings › Assistant › Voice: a curated voice with a preview, any voice id of the provider
// (Advanced), and cloning a voice where the provider can. The pick is part of the page's draft
// (Save); cloning saves at once, since the provider creates the voice right away.
import { CLONE_CONSENT_TEXT, type VoiceCloneData, type VoiceOptionsData } from '@linedesk/actions'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { Checkbox, RadioCard } from '../ui/controls.tsx'
import { FormMessage } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { Field, Section, TextInput } from './fields.tsx'
import { readAction, useWriteAction } from './settings-api.ts'
import { cloneProblem, fileToBase64, previewUrl, voiceInEffect } from './voiceModel.ts'

const loadOptions = () => readAction<VoiceOptionsData>('voice.options')
/** The voices of the provider in effect; the same for every assistant of the install. */
export const useVoiceOptions = () => useQuery('voice.options', loadOptions, { persist: true })

/** One preview at a time: playing another stops the first. */
function usePreview() {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => () => audio.current?.pause(), [])
  function toggle(voiceId: string) {
    audio.current?.pause()
    if (playing === voiceId) return setPlaying(null)
    const next = new Audio(previewUrl(voiceId))
    audio.current = next
    setFailed(null)
    setPlaying(voiceId)
    next.onended = () => setPlaying(p => (p === voiceId ? null : p))
    next.onerror = () => {
      setPlaying(p => (p === voiceId ? null : p))
      setFailed(voiceId)
    }
    void next.play().catch(() => {})
  }
  return { playing, failed, toggle }
}

function PreviewButton({
  voiceId,
  preview,
  label,
}: {
  voiceId: string
  preview: ReturnType<typeof usePreview>
  label: string
}) {
  const on = preview.playing === voiceId
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={on ? 'pause' : 'play'}
      aria-label={`${on ? 'Stop' : 'Play'} ${label}`}
      title={`${on ? 'Stop' : 'Play'} a sample of ${label}`}
      onClick={() => preview.toggle(voiceId)}
    />
  )
}

type Props = {
  assistantId: string
  voice: { provider: string; voice_id: string }
  onPick: (voice: { provider: string; voice_id: string }) => void
  canEdit: boolean
  toast: (text: string) => void
}

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

export function VoiceSettings({ assistantId, voice, onPick, canEdit, toast }: Props) {
  const { data: options } = useVoiceOptions()
  const preview = usePreview()
  const provider = options?.provider ?? null
  const current = voiceInEffect(voice, provider)
  const choices = [
    ...(options?.voices ?? []).map(v => ({ id: v.id, name: v.name, description: v.description })),
    ...(options?.clones ?? []).map(v => ({ id: v.id, name: v.name, description: 'Cloned voice of this workspace' })),
  ]
  const pick = (voiceId: string) => provider && onPick({ provider, voice_id: voiceId })

  if (options && !provider)
    return (
      <Section id="as-voice" title="Voice">
        <span className="help">No voice provider yet (Admin, Providers).</span>
      </Section>
    )
  return (
    <Section id="as-voice" title="Voice" help="Applies from the next call.">
      <div className="vc-list" role="radiogroup" aria-label="Voice">
        <div className="vc-row">
          <RadioCard
            name="voice"
            checked={current === ''}
            onPick={() => pick('')}
            title="Default voice"
            description="Install default"
          />
          <span aria-hidden="true" />
        </div>
        {choices.map(v => (
          <div className="vc-row" key={v.id}>
            <RadioCard
              name="voice"
              checked={current === v.id}
              onPick={() => pick(v.id)}
              title={v.name}
              description={v.description}
            />
            <PreviewButton voiceId={v.id} preview={preview} label={v.name} />
          </div>
        ))}
      </div>
      {preview.failed && <FormMessage>The sample could not be played.</FormMessage>}
      {options?.canClone && <CloneVoice assistantId={assistantId} toast={toast} disabled={!canEdit} />}
    </Section>
  )
}
