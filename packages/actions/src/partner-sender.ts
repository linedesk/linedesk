// A white-label partner's own sender address (docs/white-label.md, slice S6): its clients' emails come from an address
// on the partner's domain (`notify@mail.theiragency.com`) once the install's email provider (Resend) verified the
// domain's DNS records, and replies go to the partner's support email once its owner proved it with a code. Anything
// short of that: the install's address with the partner's name, and no Reply-To, as before. Never for billing emails.
import { z } from 'zod'
import { defineAction } from './define.ts'

export const PARTNER_SENDER_STATES = ['pending', 'verified', 'failed', 'stopped'] as const
export type PartnerSenderState = (typeof PARTNER_SENDER_STATES)[number]

/** One DNS record the partner adds at its DNS host, as the email provider asks for it. */
export type SenderRecord = {
  type: string
  name: string
  value: string
  priority: number | null
  /** Whether the provider found it: `verified`, else not yet. */
  found: boolean
}

/** `partnerSender.get`: the sender, the Reply-To address and whether the owner can change them. */
export type PartnerSenderData = {
  /** The install sends with a provider that can verify partner domains (Resend with a domains key); else hidden. */
  available: boolean
  /** What is still missing before a sender can be added: an approved brand, a paid first invoice. Null: nothing. */
  locked: { brandApproved: boolean; paid: boolean } | null
  sender: {
    address: string
    domain: string
    status: PartnerSenderState
    records: SenderRecord[]
    lastCheckedAt: string | null
    verifiedAt: string | null
    failedAt: string | null
  } | null
  /** The last sender a server admin removed, with its reason, while no new one is added. */
  removedByAdmin: { address: string; reason: string; at: string } | null
  /** The From line the partner's emails carry now. */
  fromLine: string
  /** The approved support email, and whether its owner proved it (only then it is Reply-To). */
  support: { address: string | null; verified: boolean; draft: string | null }
  canEdit: boolean
}

/**
 * Why a sender action was refused, as the rejection's `code`: the web app shows `team.partner.sender.error.<code>`.
 */
export const PARTNER_SENDER_CODES = [
  'sender_unavailable',
  'sender_locked',
  'sender_exists',
  'no_sender',
  'address_invalid',
  'domain_install',
  'domain_protected',
  'domain_taken',
  'provider_failed',
  'too_many_checks',
  'too_many_tests',
  'not_verified',
  'support_missing',
  'too_many_codes',
  'code_wrong',
] as const
export type PartnerSenderCode = (typeof PARTNER_SENDER_CODES)[number]

/** The local part the provider and the database accept: `notify`, `hello.team`, `no-reply`. */
export const SENDER_LOCAL_PART = /^[a-z0-9][a-z0-9._-]{0,31}$/
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * `notify@mail.theiragency.com` as its local part and domain, lower-case; null for anything a sender cannot be: no
 * domain with a dot, an IP address, a label that is not letters, digits and hyphens, a local part with other signs.
 */
export function parseSenderAddress(address: string): { localPart: string; domain: string } | null {
  const value = address.trim().toLowerCase()
  const at = value.lastIndexOf('@')
  if (at <= 0 || value.length > 254) return null
  const localPart = value.slice(0, at)
  const domain = value.slice(at + 1).replace(/\.$/, '')
  if (!SENDER_LOCAL_PART.test(localPart)) return null
  const labels = domain.split('.')
  if (labels.length < 2 || domain.length > 253 || !labels.every(l => DOMAIN_LABEL.test(l))) return null
  if (/^\d+$/.test(labels.at(-1)!)) return null
  return { localPart, domain }
}

const partnerId = z.string().min(1).max(64)

export const partnerSenderGet = defineAction({
  name: 'partnerSender.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The partner's own sender address for its clients' emails: the address, its DNS records and whether the email provider verified them, the From line emails carry now, and whether the support email (Reply-To) is proven. Anyone on the partner's team.",
  input: z.object({ partnerId }),
  permission: 'partner',
  readOnly: true,
})

export const partnerSenderAdd = defineAction({
  name: 'partnerSender.add',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Send the partner's client emails from an address on its own domain, e.g. notify@mail.yourcompany.com. Returns the DNS records to add; emails use it once the provider verified them. Needs an approved brand and a paid first invoice. The partner's owner only.",
  input: z.object({ partnerId, address: z.string().trim().min(3).max(254) }),
  permission: 'partner',
})

export const partnerSenderCheck = defineAction({
  name: 'partnerSender.check',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Ask the email provider again whether the sender domain's DNS records are in (also restarts checks that stopped). The partner's owner only; a few per 10 minutes.",
  input: z.object({ partnerId }),
  permission: 'partner',
})

export const partnerSenderSendTest = defineAction({
  name: 'partnerSender.sendTest',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Send one test email from the partner's verified sender address to the caller's own account email. The partner's owner only; 5 an hour.",
  input: z.object({ partnerId }),
  permission: 'partner',
})

export const partnerSenderRemove = defineAction({
  name: 'partnerSender.remove',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Stop sending from the partner's own address: emails come from the standard address with the partner's name again. The partner's owner only.",
  input: z.object({ partnerId }),
  permission: 'partner',
})

export const partnerSenderAdminRemove = defineAction({
  name: 'partnerSender.adminRemove',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Remove a partner's own sender address (Server admin › Partners), with a reason the partner's owner is emailed. Its emails come from the standard address again at once.",
  input: z.object({ partnerId, reason: z.string().trim().min(3).max(300) }),
  permission: 'instance:admin',
})

export const partnerBrandVerifySupportEmail = defineAction({
  name: 'partnerBrand.verifySupportEmail',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Email a 6-digit code to the partner's approved support email; partnerBrand.confirmSupportEmail with it makes that address the Reply-To of the partner's client emails. The partner's owner only; a few an hour.",
  input: z.object({ partnerId }),
  permission: 'partner',
})

export const partnerBrandConfirmSupportEmail = defineAction({
  name: 'partnerBrand.confirmSupportEmail',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Confirm the support email with the code partnerBrand.verifySupportEmail sent to it. Three tries, 10 minutes. The partner's owner only.",
  input: z.object({
    partnerId,
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/),
  }),
  permission: 'partner',
  sensitive: ['code'],
})
