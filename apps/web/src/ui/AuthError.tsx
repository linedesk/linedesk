// A failed sign-in, said in a panel: what happened in bold, what to do next below it. Messages come
// from sign-in-code.ts and read "What happened. What to do."; the first sentence is the heading.
import { Icon } from './kit.tsx'

/** Splits "That code is not right. Check the email and try again." into heading and next step. */
export function splitAuthError(message: string): { title: string; next: string | null } {
  const match = /^(.+?[.!?])\s+(\S.*)$/s.exec(message.trim())
  return match ? { title: match[1]!, next: match[2]! } : { title: message.trim(), next: null }
}

/** Announced at once (role="alert"); `id` lets a field point at it with aria-describedby. */
export function AuthError({ message, id }: { message: string; id?: string }) {
  const { title, next } = splitAuthError(message)
  return (
    <div className="auth-alert" role="alert" id={id}>
      <Icon name="alert" size={18} className="auth-alert-icon" />
      <div>
        <strong className="auth-alert-title">{title}</strong>
        {next && <span className="auth-alert-next">{next}</span>}
      </div>
    </div>
  )
}
