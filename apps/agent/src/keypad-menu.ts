// The optional keypad menu after the greeting ("For emergencies, press 1…"). Off unless the assistant
// has one. A key steers the conversation: a `transfer` key is an urgent call (transfer_call to the contacts
// that fit an urgent call when there are any, else flagged urgent and a message), a `topic` key tells the assistant what the call is about.
// Speaking instead of pressing works as always: the menu just stops listening.
import { voice } from '@livekit/agents'
import { type RemoteParticipant, type Room, RoomEvent } from '@livekit/rtc-node'
import type { Assistant, KeypadMenu } from '@linedesk/db/types'

/** How long after the menu was read the assistant waits for a key before going on. */
export const MENU_WAIT_MS = 6000

/** The assistant's menu when it has one with options; null: off. */
export const activeMenu = (assistant: Pick<Assistant, 'keypad_menu'> | null): KeypadMenu | null =>
  assistant?.keypad_menu?.options?.length ? assistant.keypad_menu : null

/** What the caller hears: "For emergencies, press 1. For billing, press 2. Or just tell me how I can help." */
export function menuPrompt(menu: KeypadMenu): string {
  const options = [...menu.options].sort((a, b) => a.key.localeCompare(b.key)).map(o => `For ${o.label}, press ${o.key}.`)
  return `${options.join(' ')} Or just tell me how I can help.`
}

/** What a key means for the assistant: a transcript line and the instructions for its next reply; null for a key not on the menu. */
export function menuChoice(menu: KeypadMenu, key: string, canTransfer: boolean): { event: string; instructions: string } | null {
  const option = menu.options.find(o => o.key === key)
  if (!option) return null
  const event = `Pressed ${key} · ${option.label}`
  if (option.action === 'topic')
    return { event, instructions: `The caller pressed ${key} on the keypad: they are calling about ${option.label}. Acknowledge it briefly and ask how you can help with that.` }
  return {
    event,
    instructions: canTransfer
      ? `The caller pressed ${key} on the keypad for ${option.label}: treat this as an urgent call. Ask for their name and what happened in one short question, then use transfer_call with every contact whose condition fits an urgent call; if none fits, use flag_urgent and take a message.`
      : `The caller pressed ${key} on the keypad for ${option.label}: treat this as an urgent call. Use flag_urgent, then ask for their name and what happened, and take a message.`,
  }
}

export type MenuOptions = {
  session: voice.AgentSession
  room: Room
  menu: KeypadMenu
  callerIdentity: () => string | undefined
  /** Whether transfer_call is there right now (it is added once known). */
  canTransfer: () => boolean
  record: (event: string) => void
  waitMs?: number
}

/** Reads the menu and acts on the first key; resolves when a key was handled, the caller spoke, or nobody pressed anything. */
export function runKeypadMenu({ session, room, menu, callerIdentity, canTransfer, record, waitMs = MENU_WAIT_MS }: MenuOptions): Promise<void> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let wrongKeys = 0
    const stop = () => {
      clearTimeout(timer)
      room.off(RoomEvent.DtmfReceived, onDigit)
      session.off(voice.AgentSessionEventTypes.UserStateChanged, onUserState)
      resolve()
    }
    const onDigit = (_code: number, digit: string, participant: RemoteParticipant) => {
      const caller = callerIdentity()
      if (caller && participant.identity !== caller) return
      const choice = menuChoice(menu, digit, canTransfer())
      session.interrupt()
      if (!choice) {
        wrongKeys++
        session.say(wrongKeys > 1 ? 'Sorry, that key is not on the menu. Just tell me how I can help.' : `Sorry, that key is not on the menu. ${menuPrompt(menu)}`)
        if (wrongKeys > 1) stop()
        return
      }
      record(choice.event)
      session.generateReply({ instructions: choice.instructions })
      stop()
    }
    const onUserState = (ev: { newState: string }) => {
      if (ev.newState === 'speaking') stop()
    }
    room.on(RoomEvent.DtmfReceived, onDigit)
    session.on(voice.AgentSessionEventTypes.UserStateChanged, onUserState)
    void session
      .say(menuPrompt(menu))
      .waitForPlayout()
      .then(() => {
        timer = setTimeout(stop, waitMs)
      }, stop)
  })
}
