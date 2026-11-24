import { useEffect, useRef } from 'react'

const STICK_TO_BOTTOM_PX = 140

/** Keep a live transcript pinned to the bottom while the reader was near it before the new turn arrived. */
export function useFollowLive(live: boolean, contentSize: number) {
  const ref = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const measure = () => {
    const el = ref.current
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX
  }
  useEffect(() => {
    const el = ref.current
    if (el && live && contentSize && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [live, contentSize])
  return { ref, onScroll: measure }
}
