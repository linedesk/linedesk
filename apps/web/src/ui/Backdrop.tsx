import { useRef, type ReactNode } from 'react'
import { useFocusTrap } from './useFocusTrap.ts'

/**
 * Dimmed layer behind a floating panel. Clicking it closes the panel; Esc does the same from the
 * keyboard. Focus stays inside while it is open and returns to where it was afterwards.
 */
export function Backdrop({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, true)
  return (
    <div className="overlay" ref={ref}>
      <button type="button" className="overlay-dismiss" aria-label="Close" tabIndex={-1} onClick={onClose} />
      {children}
    </div>
  )
}
