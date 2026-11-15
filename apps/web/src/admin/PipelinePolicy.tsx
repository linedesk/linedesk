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
import { i18n } from '../i18n/index.tsx'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { SelectRow, SkeletonSelectRow } from '../settings/fields.tsx'
import { Loading } from '../ui/LoadStates.tsx'
import type { SelectOption } from '../ui/controls.tsx'
import { runAdmin } from './api.ts'

const POLICY = 'admin.voicePipelinePolicy'
const loadPolicy = async () => (await runAdmin('voicePipelinePolicy.get', {})) as VoicePipelinePolicyData

const options = (): SelectOption<VoicePipelinePolicy>[] =>
  VOICE_PIPELINE_POLICIES.map(policy => ({
    value: policy,
    label: VOICE_PIPELINE_POLICY_LABELS[policy],
    description: policy === 'choice' ? i18n().t('admin.pipeline.optionChoice') : i18n().t('admin.pipeline.optionFixed'),
  }))

const help = () =>
  i18n().t('admin.pipeline.help', {
    realtime: VOICE_PIPELINE_LABELS.realtime,
    realtimeDescription: VOICE_PIPELINE_DESCRIPTIONS.realtime,
    threeStage: VOICE_PIPELINE_LABELS.three_stage,
    threeStageDescription: VOICE_PIPELINE_DESCRIPTIONS.three_stage,
  })

// The pipeline labels come from @linedesk/actions (English, capitalized as a title); mid-sentence they read lowercase.
const description = (policy: VoicePipelinePolicy) => {
  const t = i18n().t
  if (policy === 'choice')
    return t('admin.pipeline.descriptionChoice', { realtime: VOICE_PIPELINE_LABELS.realtime.toLowerCase() })
  if (policy === 'realtime')
    return t('admin.pipeline.descriptionRealtime', { realtime: VOICE_PIPELINE_LABELS.realtime.toLowerCase() })
  return t('admin.pipeline.descriptionThreeStage', { threeStage: VOICE_PIPELINE_LABELS.three_stage.toLowerCase() })
}

/** `onChanged`: reads the providers' status again, which says what answers the calls. */
export function PipelinePolicy({ onChanged }: { onChanged: () => Promise<void> }) {
  const t = useT()
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
      setProblem(e instanceof Error ? e.message : t('admin.pipeline.failed'))
    }
  }
  return (
    <div className="adm-pipeline-policy">
      <Loading
        what={t('admin.pipeline.what')}
        loading={!query.data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonSelectRow title={t('admin.pipeline.title')} />}
      >
        <SelectRow
          id="adm-pipeline-policy"
          title={t('admin.pipeline.title')}
          description={description(policy)}
          help={help()}
          value={policy}
          options={options()}
          onChange={next => void change(next)}
        />
      </Loading>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
