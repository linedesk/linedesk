import { z } from 'zod'
import { defineAction } from './define.ts'
import type { SetupItemId } from './setup-checklist.ts'

// Install setup by hand (LIN-128, docs/self-host-first-run.md): the small alternative to setting up with an AI agent
// (agent-setup.ts). One screen per part in the order a first answered call needs them, each with the same guide and
// keys as the setup checklist (setup-checklist.ts) and a real round trip (`provider.tryOut`). Where the admin got to
// is one instance setting, so signing in again (or another admin) resumes there.

export const installSteps = ['welcome', 'email', 'llm', 'stt', 'tts', 'telephony', 'extras', 'done'] as const
export type InstallStep = (typeof installSteps)[number]

/** The steps that set up a part of the setup checklist, and that part. */
export const installStepItems: Partial<Record<InstallStep, SetupItemId>> = {
  email: 'email',
  llm: 'llm',
  stt: 'stt',
  tts: 'tts',
  telephony: 'telephony',
}

export const installStepLabels: Record<InstallStep, string> = {
  welcome: 'Welcome',
  email: 'Email',
  llm: 'Language model',
  stt: 'Speech to text',
  tts: 'Voice',
  telephony: 'Phone carrier',
  extras: 'Optional',
  done: 'Done',
}

/** What does not work when a part is skipped, said on its Skip button and in the summary. */
export const installSkipEffects: Partial<Record<InstallStep, string>> = {
  email: 'Invitations and sign-in codes will not arrive.',
  llm: 'The assistant cannot answer calls, websites cannot be read, and calls get no summary.',
  stt: 'The assistant cannot hear callers.',
  tts: 'The assistant cannot speak.',
  telephony: 'Businesses cannot get a phone number; browser test calls still work.',
}

/** `setup.install` in instance_settings. */
export type InstallProgress = {
  step: InstallStep
  skipped: InstallStep[]
  finishedAt: string | null
  /** "Set up later": the walkthrough does not open by itself again; Admin › Overview resumes it. */
  setAsideAt: string | null
  /**
   * The instance admins who chose to set up by hand on this install: they open on the walkthrough or their business,
   * not on the agent setup page. Kept here, not in the browser, so it resets with the database and is per admin.
   */
  manualBy: string[]
}

export const installSetProgress = defineAction({
  name: 'install.setProgress',
  description:
    'Remember where the install setup by hand is: the step, a step skipped for now, set aside for later, finished, or whether you chose to set up by hand instead of with an AI agent.',
  input: z
    .object({
      step: z.enum(installSteps).optional(),
      skip: z.enum(installSteps).optional(),
      setAside: z.boolean().optional(),
      finished: z.boolean().optional(),
      /** You (this admin) chose to set up by hand (true) or with an AI agent again (false). */
      manual: z.boolean().optional(),
    })
    .refine(i => Object.values(i).some(v => v !== undefined), { message: 'say what changed' }),
  permission: 'instance:admin',
})

/** What a round trip tries: the provider in use for that part, the way a call uses it. */
export const tryOutKinds = ['email', 'llm', 'stt', 'tts', 'telephony'] as const
export type TryOutKind = (typeof tryOutKinds)[number]

export const providerTryOut = defineAction({
  name: 'provider.tryOut',
  description:
    'Try a part of the install for real with the provider in use: email sends a six-digit code to your own address (confirm it with provider.confirmEmail), llm asks the live model one short question, stt transcribes a bundled recording, tts speaks a sentence, telephony lists three available numbers for an area code without buying any.',
  input: z.object({
    kind: z.enum(tryOutKinds),
    /** telephony: the US area code to search. */
    areaCode: z
      .string()
      .regex(/^[2-9]\d\d$/, 'a three-digit US area code')
      .optional(),
  }),
  permission: 'instance:admin',
  // Like provider.test: no row changes, so not a command; the provider calls hold no transaction open, and the
  // answer (the admin's address, the model's reply, the audio) stays out of the command log.
  readOnly: true,
  secretResult: ['audio'],
})

/** `data` of provider.tryOut. `ok` false: `message` says what failed and what to do. */
export type TryOutData = {
  ok: boolean
  kind: TryOutKind
  message: string
  /** The provider tried, its label. */
  provider: string | null
  seconds?: number
  /** llm: the model's answer. */
  reply?: string
  /** stt: what the recording says, and what came back. */
  expected?: string
  heard?: string
  /** tts: the sentence as a data: URL to play. */
  audio?: string
  /** telephony: available numbers (E.164). */
  numbers?: string[]
  /** email: the address the code went to. */
  sentTo?: string
}

export const providerConfirmEmail = defineAction({
  name: 'provider.confirmEmail',
  description: 'Check the six-digit code from the test email sent by provider.tryOut: delivery works end to end.',
  input: z.object({ code: z.string().regex(/^\d{6}$/, 'the six digits from the email') }),
  permission: 'instance:admin',
  readOnly: true,
  sensitive: ['code'],
})

/** GET /v1/admin/install-setup. */
export type InstallSetupState = {
  /** False on Cloud (LINEDESK_INSTALL_SETUP=off): the setup checklist only. */
  enabled: boolean
  progress: InstallProgress
  /**
   * Email and sign-in are read at start: `pending` while a saved change waits for a restart; `automatic` when the API
   * restarts itself (Docker), else the admin restarts it.
   */
  restart: { pending: boolean; automatic: boolean }
  emailDelivery: 'smtp' | 'log' | 'none'
}
