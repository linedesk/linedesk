import { Component, type ReactNode } from 'react'

type Props = { children: ReactNode; fallback: ReactNode }

/** Shows the fallback instead of a blank screen when a page throws while rendering. Remount (key) to retry. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override componentDidCatch(error: unknown) { console.error('page failed to render', error) }
  override render() { return this.state.failed ? this.props.fallback : this.props.children }
}
