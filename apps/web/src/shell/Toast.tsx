import { Kbd } from '../ui/kit.tsx'
import type { ToastState } from './useToast.ts'
import { useT } from '@linedesk/i18n/react'

export function Toast({ toast, onUndo }: { toast: ToastState; onUndo: () => void }) {
  const t = useT()
  return (
    <div className={toast.undo ? 'toast has-undo' : 'toast'} role="status" aria-live="polite">
      <span>{toast.text}</span>
      {toast.undo && <button type="button" className="toast-undo" onClick={onUndo}><Kbd keys={['Z']} />{t('common.action.undo')}</button>}
    </div>
  )
}
