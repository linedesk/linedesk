// The evaluation's score in words, as a quiet badge; the number and the judge in its tooltip. Staff only: the call
// view's card for server admins and Server admin › Call reviews.
import { useT } from '@linedesk/i18n/react'
import { Badge } from '../ui/kit.tsx'
import { needsALook, scoreWords } from './reviewModel.ts'

export function ScoreBadge({ score, model }: { score: number; model: string | null }) {
  const t = useT()
  return (
    <Badge
      tone={needsALook(score) ? 'outline' : 'neutral'}
      title={model ? t('settings.review.scoreTip', { score, model }) : t('settings.review.scoreTipDefault', { score })}
    >
      {scoreWords(score)}
    </Badge>
  )
}
