// Web Push in the browser: subscribing this browser with the service worker (public/sw.js), knowing
// whether it gets pushes in the open workspace, and ending its subscription on sign-out. The
// subscription (endpoint and keys) only goes to the API (push.subscribe); it is never stored here.
import { pushDeviceId } from '@linedesk/actions'
import { serviceWorkerSupported } from './serviceWorker.ts'
import { workspaceHeaders } from './tabWorkspace.ts'

export type PushSupport = 'supported' | 'unsupported' | 'ios-needs-install'

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isInstalled = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true

/** iOS and iPadOS only offer push to an app added to the Home Screen. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  if (isIos() && !isInstalled()) return 'ios-needs-install'
  if (!serviceWorkerSupported() || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  return 'supported'
}

/** This browser's push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null
  const registration = await navigator.serviceWorker.getRegistration()
  return (await registration?.pushManager.getSubscription()) ?? null
}

/** This browser's device id (see pushDeviceId), or null without a subscription. */
export async function thisDeviceId(): Promise<string | null> {
  const subscription = await currentSubscription()
  return subscription ? pushDeviceId(subscription.endpoint) : null
}

/** The VAPID key as the bytes pushManager.subscribe wants. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

export type PushInput = { endpoint: string; keys: { p256dh: string; auth: string } }

/**
 * Asks for permission and subscribes this browser with the server's key. A subscription made with an
 * older key (the operator replaced it) is replaced. Returns what push.subscribe needs.
 */
export async function subscribeThisBrowser(publicKey: string): Promise<PushInput | 'denied'> {
  if ((await Notification.requestPermission()) !== 'granted') return 'denied'
  const registration = await navigator.serviceWorker.ready
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }
  let subscription: PushSubscription
  try {
    subscription = await registration.pushManager.subscribe(options)
  } catch (e) {
    const existing = await registration.pushManager.getSubscription()
    if (!existing) throw e
    await existing.unsubscribe()
    subscription = await registration.pushManager.subscribe(options)
  }
  const json = subscription.toJSON()
  return { endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } }
}

const SIGN_OUT_WAIT_MS = 3000

/**
 * On sign-out: the server forgets this browser in all of the member's workspaces (while the session
 * still exists), then the browser ends the subscription, so nothing reaches it any more even if the
 * first step failed (offline): the push service then reports it gone and the server deletes it.
 */
export async function stopPushOnSignOut() {
  const subscription = await currentSubscription().catch(() => null)
  if (!subscription) return
  await fetch('/v1/actions/push.unsubscribe', {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ endpoint: subscription.endpoint, everywhere: true }),
    signal: AbortSignal.timeout(SIGN_OUT_WAIT_MS),
  }).catch(() => null)
  await subscription.unsubscribe().catch(() => false)
}

/** When the session is already gone (removed, another account): only the browser side is left to end. */
export async function endBrowserPush() {
  const subscription = await currentSubscription().catch(() => null)
  await subscription?.unsubscribe().catch(() => false)
}

const OPEN_CALL = 'linedesk:open-call'

/** Clicking a push opens its call in an open Linedesk window (the service worker sends this). */
export function onPushOpensCall(open: (callId: string) => void): () => void {
  if (!serviceWorkerSupported()) return () => {}
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: string; callId?: unknown } | null
    if (data?.type === OPEN_CALL && typeof data.callId === 'string') open(data.callId)
  }
  navigator.serviceWorker.addEventListener('message', listener)
  // With addEventListener (unlike onmessage) the browser holds the worker's messages until this.
  navigator.serviceWorker.startMessages()
  return () => navigator.serviceWorker.removeEventListener('message', listener)
}
