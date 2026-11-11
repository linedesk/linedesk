// A collection step on a live call: a LiveKit AgentTask that takes over the conversation until the
// value is confirmed, the caller declines, or the tries run out, then hands back to the assistant.
// Keypad presses (SIP DTMF) count as the caller's answer where the step allows them.
import { llm, voice } from '@livekit/agents'
import { type RemoteParticipant, type Room, RoomEvent } from '@livekit/rtc-node'
import { z } from 'zod'
import { Collection, type CollectOutcome, KeypadInput, type StepReply } from './collection.ts'
import type { Collector } from './collectors.ts'

/** Ported from LiveKit's Python tasks: the rules every step shares. */
const STEP_RULES = [
  'You are only a single step in a phone call, responsible solely for collecting one piece of information. Speak English, one or two short sentences at a time, no lists or markdown.',
  'Call the record tool as soon as you form a new hypothesis about the value, before asking anything else. Do not invent values: stick strictly to what the caller said.',
  'After the record tool, read the value back exactly as it tells you and ask whether it is right. If the caller says yes, call the confirm tool; if they say no or correct it, call the wrong tool (or record the correction).',
  'If the caller does not want to give it, call decline. Ignore unrelated requests: say you will come back to that in a moment. Always call tools explicitly; never pretend to.',
].join('\n')

// biome-ignore lint/suspicious/noExplicitAny: a step holds one collector of any argument and value type
type AnyCollector = Collector<any, any>

export type CollectTaskOptions = {
  collector: AnyCollector
  /** The call so far, so a name or number already given is not asked again. */
  chatCtx?: llm.ChatContext
  /** Keypad input: the call's room and the caller's identity (presses from anyone else are ignored). */
  keypad?: { room: Room; callerIdentity?: string }
}

export class CollectTask extends voice.AgentTask<CollectOutcome> {
  private readonly collection: Collection<Record<string, unknown>, unknown>
  private readonly keypadInput: KeypadInput | null
  private readonly room: Room | null
  private readonly callerIdentity: string | undefined

  constructor({ collector, chatCtx, keypad }: CollectTaskOptions) {
    const collection = new Collection(collector)
    const kind = collector.kind
    // The tools finish the task; it exists once super() returned.
    const self: { task?: CollectTask } = {}
    const settle = (reply: StepReply) => {
      if (reply.outcome && self.task && !self.task.done) self.task.complete(reply.outcome)
      return reply.outcome ? undefined : reply.say
    }
    super({
      instructions: `${STEP_RULES}\n\n${collector.instructions}${collector.keypad && keypad ? '\nThe caller may also type it on the phone keypad; typed digits arrive by themselves.' : ''}`,
      ...(chatCtx ? { chatCtx } : {}),
      tools: {
        [`record_${kind}`]: llm.tool({
          description: `Record the ${collector.label} the caller just said (or a correction).`,
          parameters: collector.parameters as z.ZodObject<z.ZodRawShape>,
          execute: async args => settle(collection.record(args as Record<string, unknown>)),
        }),
        [`confirm_${kind}`]: llm.tool({
          description: `Call only after the caller said the ${collector.label} you read back is right.`,
          execute: async () => settle(collection.confirm()),
        }),
        [`wrong_${kind}`]: llm.tool({
          description: `The caller says the ${collector.label} you read back is wrong and did not say the right one yet.`,
          execute: async () => settle(collection.reject()),
        }),
        decline: llm.tool({
          description: `The caller does not want to give the ${collector.label}, or cannot.`,
          parameters: z.object({ reason: z.string().describe('In a few words, why.') }),
          execute: async ({ reason }) => settle(collection.decline(reason)),
        }),
      },
    })
    self.task = this
    this.collection = collection
    this.room = keypad?.room ?? null
    this.callerIdentity = keypad?.callerIdentity
    this.keypadInput =
      collector.keypad && keypad ? new KeypadInput(collector.keypad.maxDigits, result => void this.onTyped(result.digits)) : null
  }

  private readonly onDigit = (_code: number, digit: string, participant: RemoteParticipant) => {
    if (this.callerIdentity && participant.identity !== this.callerIdentity) return
    this.keypadInput?.press(digit)
  }

  /** Typed digits are checked in code (no model guessing) and read back like spoken ones. */
  private async onTyped(digits: string) {
    const keypad = this.collection.collector.keypad
    if (!keypad || this.done) return
    this.session.interrupt()
    const reply = this.collection.record(keypad.toArgs(digits), 'keypad')
    this.keypadInput?.reset()
    if (reply.outcome) {
      if (!this.done) this.complete(reply.outcome)
      return
    }
    this.session.generateReply({ instructions: `The caller typed ${digits || 'nothing'} on the keypad. ${reply.say}`, toolChoice: 'none' })
  }

  override async onEnter() {
    if (this.keypadInput) this.room?.on(RoomEvent.DtmfReceived, this.onDigit)
    this.session.generateReply({
      instructions: `${this.collection.collector.ask} If the caller already gave it earlier in this call, record it with the record tool and read it back instead of asking again.`,
    })
  }

  override async onExit() {
    this.room?.off(RoomEvent.DtmfReceived, this.onDigit)
    this.keypadInput?.stop()
  }
}
