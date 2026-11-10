import { Kbd } from '../ui/kit.tsx'
import type { ToastState } from './useToast.ts'

export function Toast({ toast, onUndo }: { toast: ToastState; onUndo: () => void }) {
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{toast.text}</span>
      {toast.undo && <button type="button" className="toast-undo" onClick={onUndo}><Kbd keys={['Z']} />Undo</button>}
    </div>
  )
}
