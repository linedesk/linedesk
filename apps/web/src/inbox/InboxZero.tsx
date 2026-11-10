import { auth } from '../auth.ts'
import { useAssistantName } from '../store.tsx'
import { Kbd } from '../ui/kit.tsx'

function greeting(now = new Date()) {
  const hour = now.getHours()
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

/** Calm full-height state when nothing needs a person. */
export function InboxZero({ handledCount }: { handledCount: number }) {
  const firstName = auth.useSession().data?.user.name.split(' ')[0]
  const assistant = useAssistantName()
  return (
    <div className="zero" role="status">
      <svg className="zero-art" width={168} height={112} viewBox="0 0 168 112" aria-hidden="true" focusable="false">
        <circle cx={84} cy={70} r={34} className="zero-sun" />
        <rect x={0} y={70} width={168} height={42} className="zero-ground" />
        <path d="M8 70h152" className="zero-line" />
        <path d="M30 84h44M96 84h36M52 96h64" className="zero-wave" />
        <path d="M74 58l7 7 14-14" className="zero-check" />
      </svg>
      <h2>All calls handled</h2>
      <p className="zero-greet">{greeting()}{firstName ? `, ${firstName}` : ''}</p>
      <p className="zero-stat">The assistant resolved <b>{handledCount}</b>{handledCount === 1 ? ' call on its own' : ' calls on its own'}</p>
      <p className="zero-hint">Press <Kbd keys={['tab']} /> to check Handled by {assistant}</p>
    </div>
  )
}
