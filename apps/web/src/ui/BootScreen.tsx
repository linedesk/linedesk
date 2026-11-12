import { BrandMark } from './kit.tsx'

/**
 * The first thing on screen while the session or the local store opens: the mark and a quiet line.
 * It fades in after a moment, so a fast start shows nothing at all, and a slow one never a blank page.
 */
export function BootScreen({ line }: { line: string }) {
  return (
    <div className="boot boot-loading" role="status">
      <BrandMark className="ws-mark boot-mark" />
      <span>{line}</span>
    </div>
  )
}
