// The tools the assistant has on a call (LIN-391: moved here from worker.ts unchanged, so the LLM test suite in
// llm-test/ offers the model exactly these definitions). The worker passes the call's runtime pieces in.
import { llm } from '@livekit/agents'
import { z } from 'zod'
import type { ApiClient } from './api-client.ts'
import { bookingTools } from './booking-tools.ts'
import type { CallLog } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import { type CollectContext, collectTools, nudgeIfQuiet } from './collect/collect-tools.ts'
import type { Reply } from './hang-up.ts'
import { lookupTools } from './lookup-tools.ts'
import { canChangeBookings } from './prompt.ts'
import { type ToolStarted, withFillers } from './tool-filler.ts'
import { transferTool } from './transfer-tool.ts'

/**
 * A tool that saves something (a booking, the urgent flag): from its start the caller can't interrupt the
 * turn, so an interruption never cancels the tool after the API saved and the assistant always hears the result.
 */
export function saving(opts: llm.ToolOptions): void {
  opts.ctx.disallowInterruptions()
}

async function nudged(opts: llm.ToolOptions, result: Promise<string>): Promise<string> {
  const text = await result
  nudgeIfQuiet(opts.ctx.session)
  return text
}

/** find_slots and book_appointment, only when the assistant has an appointment type and a calendar. */
// biome-ignore lint/suspicious/noExplicitAny: tools of different parameter types in one map
export function bookingToolset(api: ApiClient, call: CallSession, log: CallLog): Record<string, llm.AnonFunctionTool<any, any, any>> {
  if (!call.booking) return {}
  const booking = bookingTools(api, call, log)
  const typeId = z.string().describe('The id of the appointment type whose "use when" fits the request, from the list in your instructions.')
  const calendarId = z.string().nullish().describe('The id of the calendar whose "use when" fits the request, from the list in your instructions; leave it out when no calendars are listed.')
  const bookingDate = z.string().describe('The day of the appointment the caller wants to change, as the caller said it, in English ("Tuesday", "the 17th", "November 17") or YYYY-MM-DD.')
  return {
    find_slots: llm.tool({
      description: 'Look up free times for an appointment in one calendar.',
      parameters: z.object({
        appointment_type_id: typeId,
        calendar_id: calendarId,
        from_date: z.string().nullish().describe('First day to look at, as the caller said it, in English ("tomorrow", "Wednesday", "next week", "the 17th", "November 17") or YYYY-MM-DD; omit for today.'),
        to_date: z.string().nullish().describe('Last day to look at, said the same way ("Friday", "next week" for its Sunday); omit to look ahead as far as possible.'),
      }),
      execute: (args, opts) => nudged(opts, booking.findSlots(args)),
    }),
    book_appointment: llm.tool({
      description: 'Book a time the caller chose from find_slots, only after the caller said yes to that exact time.',
      parameters: z.object({
        appointment_type_id: typeId,
        calendar_id: calendarId,
        start: z.string().describe('The key in brackets of the chosen time from find_slots, like s3.'),
        caller_name: z.string().nullish().describe("The caller's name; needed when the appointment type asks for it."),
        reason: z.string().describe('One sentence: what the appointment is for.'),
        address: z.string().nullish().describe('Where the visit is, if it is on site.'),
        email: z.string().nullish().describe("The caller's email address, if they gave one: the confirmation goes there."),
      }),
      // The name the caller confirmed letter by letter wins over the model's spelling of it.
      execute: (args, opts) => (saving(opts), nudged(opts, booking.book({ ...args, caller_name: log.confirmedName ?? args.caller_name }))),
    }),
    ...(canChangeBookings(call.booking)
      ? {
          cancel_appointment: llm.tool({
            description: 'Cancel an appointment of the caller, described by the day it is on. It goes by the name the caller confirmed with get_name: get that first.',
            parameters: z.object({ booking_date: bookingDate }),
            execute: (args, opts) => (saving(opts), nudged(opts, booking.cancel(args))),
          }),
          reschedule_appointment: llm.tool({
            description: 'Move an appointment of the caller, described by its day, to a time from find_slots the caller agreed to. It goes by the name the caller confirmed with get_name: get that first.',
            parameters: z.object({
              booking_date: bookingDate,
              appointment_type_id: typeId,
              calendar_id: calendarId.describe('The calendar id you used for find_slots.'),
              start: z.string().describe('The key in brackets of the new time from find_slots, like s3.'),
            }),
            execute: ({ start, appointment_type_id, calendar_id, ...which }, opts) => (saving(opts), nudged(opts, booking.reschedule(which, start, { appointment_type_id, calendar_id }))),
          }),
        }
      : {}),
  }
}

/** transfer_call, when the assistant has transfer contacts that take calls now; given from the start of the call. */
export type Transfer = Omit<Parameters<typeof transferTool>[0], 'api' | 'call' | 'log'> | null

export function assistantTools(api: ApiClient, call: CallSession, log: CallLog, endCall: (toolReply: Reply) => string, flagUrgent: () => Promise<void>, transfer: Transfer, collect: CollectContext, filler: ToolStarted) {
  return {
    // A slow tool gets a filler when the assistant said nothing before it (tool-filler.ts).
    ...withFillers({ ...bookingToolset(api, call, log), ...lookupTools(api, call, log) }, filler),
    ...collectTools(collect),
    ...(transfer ? { transfer_call: transferTool({ ...transfer, api, call, log }) } : {}),
    end_call: llm.tool({
      description: 'End the call. The first call asks the caller whether there is anything else; call it again after they said no, and it says goodbye and hangs up. Never in the same response as another tool.',
      // The first call asks "anything else?", the next one right after the answer says the goodbye line and hangs up (closingFlow).
      execute: async (_, { ctx }) => endCall(ctx.speechHandle),
    }),
    flag_urgent: llm.tool({
      description: "Flag this call as urgent: only when the caller's problem is one the owner's instructions call urgent, or the caller says it is urgent. Call it in the same response in which you tell the caller.",
      execute: async (_, opts) => {
        saving(opts)
        await flagUrgent()
        return 'The call is flagged as urgent. Do not promise a response time.'
      },
    }),
  }
}
