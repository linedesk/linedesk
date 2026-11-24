// A failed sign-in, said in a danger note: what happened in bold, what to do next below it. Messages come
// from sign-in-code.ts and read "What happened. What to do."; the first sentence is the heading.
import { Note } from './kit.tsx'

/** Splits "That code is not right. Check the email and try again." into heading and next step. */
export function splitAuthError(message: string): { title: string; next: string | null } {
  const match = /^(.+?[.!?])\s+(\S.*)$/s.exec(message.trim())
  return match ? { title: match[1]!, next: match[2]! } : { title: message.trim(), next: null }
}

type Props = { message: string; id?: string; link?: { href: string; label: string } }

/** Announced at once (role="alert"); `id` lets a field point at it with aria-describedby; `link`: where to go to fix it. */
export function AuthError({ message, id, link }: Props) {
  const { title, next } = splitAuthError(message)
  return (
    <Note tone="danger" title={title} id={id}>
      {next}
      {link && (
        <>
          {next && ' '}
          <a href={link.href}>{link.label}</a>
        </>
      )}
    </Note>
  )
}
