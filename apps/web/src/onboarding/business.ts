// "Find your business" without React: what the owner typed, the profile draft from a business.import proposal, the
// industry template's default use cases, and what saving the reviewed draft writes.
import {
  type BusinessHoursSpan,
  type BusinessImportData,
  type BusinessLookupFailure,
  type BusinessTemplateId,
  businessPhoneProblem,
  businessTemplates,
  businessWebsiteProblem,
  greetingFor,
  INSTRUCTIONS_MAX,
  phoneNumberProblem,
  workspaceNameProblem,
} from '@linedesk/actions'
import type { BusinessProfile } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import type { WebsiteImport } from '../auth.ts'
import { i18n } from '../i18n/index.tsx'

/**
 * What the step shows for the website: the field (`field`), a quiet line that reading is paused for today
 * (`paused`), the line for instance admins that it needs a language model (`needs_model`), or nothing (`hidden`:
 * no model and not an admin, or an import just failed and its error says why). Only `field` reads a website, so
 * continuing never needs a field cleared. Absent (an older server): the field, as before.
 */
export type WebsiteChoice = 'field' | 'paused' | 'needs_model' | 'hidden'
export function websiteChoice(state: WebsiteImport | undefined, admin: boolean, failed: boolean): WebsiteChoice {
  if (failed) return 'hidden'
  if (state === 'paused') return 'paused'
  if (state === 'no_model') return admin ? 'needs_model' : 'hidden'
  return 'field'
}

/** "brightwater-plumbing.example", "https://…", "www.x.com/contact": a website, not a name to search for. */
export function looksLikeWebsite(typed: string): boolean {
  const text = typed.trim()
  if (/^https?:\/\//i.test(text)) return true
  return !/\s/.test(text) && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(text)
}

/** What the review edits. Lists are one item per line, as the owner types them. */
export type ProfileDraft = {
  name: string
  address: string
  area: string
  phone: string
  website: string
  /** Null until the owner chooses, when the lookup did not tell. */
  template: BusinessTemplateId | null
  services: string
  about: string
  useCases: string
  greeting: string
  /** Google's hours, saved as the business hours only when the owner keeps this on. */
  useHours: boolean
  hours: BusinessHoursSpan[] | null
  hoursText: string[]
  timeZone: string | null
}

const lines = (text: string) =>
  text
    .split('\n')
    .map(l => l.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean)
const unique = (list: string[]) => [...new Set(list)]

/** The template's default use cases (none before one is chosen), then the website's that are not already there. */
export const templateUseCases = (template: BusinessTemplateId | null, fromSite: readonly string[]) =>
  unique([...(template ? businessTemplates[template].useCases : []), ...fromSite])

/** The draft the review starts from. Hours are offered on (the owner unticks them), only when Google has them. */
export function draftFrom(proposal: BusinessImportData): ProfileDraft {
  return {
    name: proposal.name,
    address: proposal.address ?? '',
    area: proposal.area ?? '',
    phone: proposal.phone ?? '',
    website: proposal.website ?? '',
    template: proposal.template,
    services: proposal.services.join('\n'),
    about: proposal.about,
    useCases: templateUseCases(proposal.template, proposal.useCases).join('\n'),
    greeting: proposal.greeting,
    useHours: !!proposal.hours?.length,
    hours: proposal.hours,
    hoursText: proposal.hoursText,
    timeZone: proposal.timeZone,
  }
}

/**
 * A proposal from the name alone (nothing looked up or read): the owner chooses the kind of business; a website typed
 * is kept as is.
 */
export function manualProposal(name: string, assistantName: string, website = ''): BusinessImportData {
  return {
    name: name.trim(),
    address: null,
    area: null,
    phone: null,
    website: website.trim() || null,
    hours: null,
    hoursText: [],
    timeZone: null,
    template: null,
    services: [],
    about: '',
    useCases: [],
    greeting: greetingFor(name, assistantName),
    pages: [],
    notes: [],
    failures: [],
  }
}

/** The common calls in saved instructions (instructionsOf writes them as "Common calls:" and one "- " line each). */
export function commonCallsOf(instructions: string | undefined): string[] {
  const at = instructions?.indexOf('Common calls:\n') ?? -1
  if (at < 0) return []
  const block = instructions!.slice(at + 'Common calls:\n'.length).split('\n\n')[0] ?? ''
  return lines(block)
}

/**
 * A proposal from the profile saved before (coming back to this step): the review starts from it, so saving again
 * keeps what was there. The kind of business is not stored: the owner may choose it again.
 */
export function savedProposal(profile: BusinessProfile, name: string, greeting: string): BusinessImportData {
  return {
    name: name.trim(),
    address: profile.address ?? null,
    area: profile.service_area ?? null,
    phone: profile.phone ?? null,
    website: profile.website ?? null,
    hours: null,
    hoursText: [],
    timeZone: null,
    template: null,
    services: profile.services ?? [],
    about: profile.description ?? '',
    useCases: commonCallsOf(profile.instructions),
    greeting,
    pages: [],
    notes: [],
    failures: [],
  }
}

/**
 * Another industry: the old template's default use cases leave the list, the new one's come first; lines the owner
 * wrote or the website gave stay.
 */
export function switchTemplate(draft: ProfileDraft, template: BusinessTemplateId): ProfileDraft {
  const old = new Set(draft.template ? businessTemplates[draft.template].useCases : [])
  const kept = lines(draft.useCases).filter(l => !old.has(l))
  return { ...draft, template, useCases: templateUseCases(template, kept).join('\n') }
}

/** A renamed business: the greeting follows when it still names the old name. */
export function renameBusiness(draft: ProfileDraft, name: string): ProfileDraft {
  const old = draft.name.trim()
  const greeting =
    old && draft.greeting.includes(old) ? draft.greeting.split(old).join(name.trim() || old) : draft.greeting
  return { ...draft, name, greeting }
}

/** The About text the assistant answers from: the brief, then services, area, address and the common calls. */
export function instructionsOf(draft: ProfileDraft): string {
  const services = lines(draft.services)
  const useCases = lines(draft.useCases)
  return [
    draft.about.trim(),
    services.length ? `Services: ${services.join('; ')}.` : null,
    draft.area.trim() ? `Service area: ${draft.area.trim()}.` : null,
    draft.address.trim() ? `Address: ${draft.address.trim()}.` : null,
    useCases.length ? `Common calls:\n${useCases.map(u => `- ${u}`).join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, INSTRUCTIONS_MAX)
}

/** What is wrong with the draft, per field (shown under it); empty when it can be saved. */
export function draftProblems(draft: ProfileDraft): Partial<Record<'name' | 'phone' | 'website', string>> {
  const problems: Partial<Record<'name' | 'phone' | 'website', string>> = {}
  const name = draft.name.trim() ? workspaceNameProblem(draft.name) : i18n().t('onboarding.business.nameRequired')
  if (name) problems.name = name
  // The phone field's value is E.164 as far as typed: an unfinished number says so for its country.
  const phone =
    (draft.phone.trim().startsWith('+') ? phoneNumberProblem(draft.phone, i18n()) : null) ??
    businessPhoneProblem(draft.phone)
  if (phone) problems.phone = phone
  const website = businessWebsiteProblem(draft.website)
  if (website) problems.website = website
  return problems
}

/** Why the draft cannot be saved yet, or null. */
export function draftProblem(draft: ProfileDraft): string | null {
  return Object.values(draftProblems(draft))[0] ?? null
}

/** What saving writes: the assistant's greeting and profile; the hours and their zone only when the owner kept them. */
export function profileSave(
  draft: ProfileDraft,
  saved: BusinessProfile,
  workspaceName: string,
): {
  /** The greeting only when there is one: the next step asks for it, this one only names the business in it. */
  assistant: { greeting?: string; business_profile: BusinessProfile }
  hours: BusinessHoursSpan[] | null
  timeZone: string | null
  /** The new workspace name when the owner changed the business name; null when it stays. */
  rename: string | null
} {
  // A field left empty keeps what was saved: saving never wipes the profile's phone, website or address.
  const optional = (text: string, kept: string | undefined) => text.trim() || kept
  // Google's hours (and their text in the profile) are kept only when the owner ticks "Use these hours".
  const keepHours = draft.useHours && !!draft.hours?.length
  const business_profile: BusinessProfile = {
    ...saved,
    instructions: instructionsOf(draft),
    description: optional(draft.about, saved.description),
    services: lines(draft.services).length ? lines(draft.services) : saved.services,
    service_area: optional(draft.area, saved.service_area),
    address: optional(draft.address, saved.address),
    phone: optional(draft.phone, saved.phone),
    website: optional(draft.website, saved.website),
    hours: keepHours && draft.hoursText.length ? draft.hoursText.join('\n') : saved.hours,
  }
  // Fields left empty are not sent: assistant.update keeps the profile as given.
  for (const key of Object.keys(business_profile) as (keyof BusinessProfile)[])
    if (business_profile[key] === undefined) delete business_profile[key]
  const name = draft.name.trim()
  return {
    assistant: { ...(draft.greeting.trim() ? { greeting: draft.greeting.trim() } : {}), business_profile },
    hours: keepHours ? draft.hours : null,
    timeZone: keepHours ? draft.timeZone : null,
    rename: name && name !== workspaceName.trim() ? name : null,
  }
}

/**
 * A provider the step could not use, in words: what happened (`text`) and, for instance admins, the sentence with the
 * link to its group in Server admin › Providers (`adminFix`, a message with a `<link>` tag; `group`). Members get "Ask
 * whoever runs this server."
 */
export type ProviderProblem = { text: string; adminFix: MessageKey; group: 'answering' | 'business' }
export function providerProblem(failure: BusinessLookupFailure, where: 'search' | 'listing'): ProviderProblem {
  const { t } = i18n()
  if (failure.provider === 'llm')
    return {
      text:
        where === 'listing' ? t('onboarding.business.problem.llmListing') : t('onboarding.business.problem.llmSearch'),
      adminFix: msg('onboarding.business.problem.fixSetOneUp'),
      group: 'answering',
    }
  const auth = failure.reason === 'auth'
  const text =
    where === 'search'
      ? t(auth ? 'onboarding.business.problem.searchAuth' : 'onboarding.business.problem.searchConfig')
      : t(auth ? 'onboarding.business.problem.listingAuth' : 'onboarding.business.problem.listingConfig')
  return {
    text,
    adminFix: msg(auth ? 'onboarding.business.problem.fixCheckKey' : 'onboarding.business.problem.fixSetItUp'),
    group: 'business',
  }
}

/** Where the proposal came from, for the line above the review. */
export function sourcesLine(pages: BusinessImportData['pages'], fromGoogle: boolean) {
  const { t } = i18n()
  if (!pages.length) return t(fromGoogle ? 'onboarding.business.sources.listing' : 'onboarding.business.sources.none')
  const host = (() => {
    try {
      return new URL(pages[0]!.url).host.replace(/^www\./, '')
    } catch {
      return null
    }
  })()
  const count = pages.length
  if (!host)
    return t(
      fromGoogle ? 'onboarding.business.sources.listingAndPagesOfSite' : 'onboarding.business.sources.pagesOfSite',
      { count },
    )
  return t(fromGoogle ? 'onboarding.business.sources.listingAndPages' : 'onboarding.business.sources.pages', {
    count,
    host,
  })
}
