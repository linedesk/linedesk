import type { ReactNode } from 'react'

/** Dimmed layer behind a floating panel. Clicking it closes the panel; Esc does the same from the keyboard. */
export function Backdrop({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay">
      <button type="button" className="overlay-dismiss" aria-label="Close" tabIndex={-1} onClick={onClose} />
      {children}
    </div>
  )
}
