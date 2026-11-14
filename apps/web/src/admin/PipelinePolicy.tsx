// Answering calls with both ways set up (a realtime model, and speech to text, a language model and a voice): the
// instance admin picks one for every workspace, or lets each assistant choose under Settings › Assistant (LIN-192).
import {
  VOICE_PIPELINE_DESCRIPTIONS,
  VOICE_PIPELINE_LABELS,
  VOICE_PIPELINE_POLICIES,
  VOICE_PIPELINE_POLICY_LABELS,
  type VoicePipelinePolicy,
  type VoicePipelinePolicyData,
} from '@linedesk/actions'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { SelectRow } from '../settings/fields.tsx'
import type { SelectOption } from '../ui/controls.tsx'
import { HelpTip } from '../ui/form.tsx'
import { runAdmin } from './api.ts'

const POLICY = 'admin.voicePipelinePolicy'
const loadPolicy = async () => (await runAdmin('voicePipelinePolicy.get', {})) as VoicePipelinePolicyData

const options: SelectOption<VoicePipelinePolicy>[] = VOICE_PIPELINE_POLICIES.map(policy => ({
  value: policy,
  label: VOICE_PIPELINE_POLICY_LABELS[policy],
  description:
    policy === 'choice'
      ? 'Each assistant picks one under Settings, Assistant'
      : 'Every assistant uses it; Settings, Assistant shows no choice',
}))

const HELP = `${VOICE_PIPELINE_LABELS.realtime}: ${VOICE_PIPELINE_DESCRIPTIONS.realtime} ${VOICE_PIPELINE_LABELS.three_stage}: ${VOICE_PIPELINE_DESCRIPTIONS.three_stage} Both can put calls through to a person. When the one picked stops working, the other answers.`

const descriptions: Record<VoicePipelinePolicy, string> = {
  choice: `Each assistant picks under Settings, Assistant; the ${VOICE_PIPELINE_LABELS.realtime.toLowerCase()} unless it picks the other.`,
  realtime: `Every workspace's calls are answered by the ${VOICE_PIPELINE_LABELS.realtime.toLowerCase()}, whatever its assistant picked.`,
  three_stage: `Every workspace's calls are answered by ${VOICE_PIPELINE_LABELS.three_stage.toLowerCase()}, whatever its assistant picked.`,
}

/** `onChanged`: reads the providers' status again, which says what answers the calls. */
export function PipelinePolicy({ onChanged }: { onChanged: () => Promise<void> }) {
  const query = useQuery(POLICY, loadPolicy)
  const [problem, setProblem] = useState<string | null>(null)
  const policy = query.data?.policy ?? 'choice'
  async function change(next: VoicePipelinePolicy) {
    setProblem(null)
    setQueryData<VoicePipelinePolicyData | undefined>(POLICY, { policy: next })
    try {
      await runAdmin('voicePipelinePolicy.set', { policy: next })
      await onChanged()
    } catch (e) {
      setQueryData<VoicePipelinePolicyData | undefined>(POLICY, { policy })
      setProblem(e instanceof Error ? e.message : 'Could not change how calls are answered.')
    }
  }
  return (
    <div className="adm-pipeline-policy">
      <SelectRow
        id="adm-pipeline-policy"
        title="Which one answers calls"
        description={descriptions[policy]}
        note={<HelpTip text={HELP} />}
        value={policy}
        options={options}
        onChange={next => void change(next)}
      />
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
