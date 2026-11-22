// "Find your business" without React: what the owner typed, the profile draft from a business.import proposal, the
// industry template's default use cases, and what saving the reviewed draft writes.
import {
  type BusinessKind,
  type BusinessHoursSpan,
  type BusinessImportData,
  type BusinessLookupFailure,
  type BusinessTemplateId,
  aboutLabelsIn,
  allAboutLabels,
  businessPhoneProblem,
  businessTemplateIds,
  businessWebsiteProblem,
  greetingFor,
  INSTRUCTIONS_MAX,
  kindOfTemplate,
  languageCodes,
  phoneNumberProblem,
  templateFor,
  templateOfKind,
  templateUseCasesAnyLanguage,
  templateUseCasesIn,
  workspaceNameProblem,
  workspaceTimeZoneFor,
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
  /**
   * The kind of business (business-kind.ts): null until the owner chooses, when the lookup did not tell. Required to
   * continue: it picks the setup steps after onboarding (the go-live checklist).
   */
  kind: BusinessKind | null
  /** The kind's template, whose default common calls are in `useCases` (null before a kind is chosen). */
  template: BusinessTemplateId | null
  services: string
  about: string
  useCases: string
  greeting: string
  /**
   * The greeting as proposed and the business name it was made with: a rename is worked out from these each time, so
   * clearing the name and typing it again never rewrites the greeting letter by letter.
   */
  greetingFrom: { text: string; name: string }
  /** Google's hours, saved as the business hours only when the owner keeps this on. */
  useHours: boolean
  hours: BusinessHoursSpan[] | null
  hoursText: string[]
  /** The listing's time zone (Google): what the step shows as the time zone until the owner changes it. */
  timeZone: string | null
  /**
   * The workspace language the default texts are in (the template's common calls, the About labels, the greeting):
   * the language of the country the step shows (draftInLanguage when that changes).
   */
  language: string
}

const lines = (text: string) =>
  text
    .split('\n')
    .map(l => l.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean)
const unique = (list: string[]) => [...new Set(list)]

/**
 * The template's default use cases in the workspace language (none before one is chosen), then the website's (or the
 * owner's) that are not already there; the template's lines in another language give way to these.
 */
export function templateUseCases(template: BusinessTemplateId | null, fromSite: readonly string[], language = 'en') {
  if (!template) return unique([...fromSite])
  const any = new Set(templateUseCasesAnyLanguage(template))
  return unique([...templateUseCasesIn(template, language), ...fromSite.filter(l => !any.has(l))])
}

/** The draft the review starts from. Hours are offered on (the owner unticks them), only when Google has them. */
export function draftFrom(proposal: BusinessImportData, language = 'en'): ProfileDraft {
  return {
    name: proposal.name,
    address: proposal.address ?? '',
    area: proposal.area ?? '',
    phone: proposal.phone ?? '',
    website: proposal.website ?? '',
    // An older API names only the template: the kind it stands for, for the owner to confirm.
    kind: proposal.kind !== undefined ? proposal.kind : kindOfTemplate(proposal.template),
    template: proposal.template,
    services: proposal.services.join('\n'),
    about: proposal.about,
    useCases: templateUseCases(proposal.template, proposal.useCases, language).join('\n'),
    greeting: proposal.greeting,
    greetingFrom: { text: proposal.greeting, name: proposal.name.trim() },
    useHours: !!proposal.hours?.length,
    hours: proposal.hours,
    hoursText: proposal.hoursText,
    timeZone: proposal.timeZone,
    language,
  }
}

/**
 * The draft in another workspace language (the owner picked another country, or the workspace's loaded): the
 * template's common calls in it, and the greeting when it is still a default one. What the owner wrote stays.
 */
export function draftInLanguage(draft: ProfileDraft, language: string, assistantName: string): ProfileDraft {
  if (draft.language === language) return draft
  const useCases = draft.template
    ? templateUseCases(draft.template, lines(draft.useCases), language).join('\n')
    : draft.useCases
  const name = draft.name.trim()
  const isDefault = name && languageCodes.some(l => greetingFor(name, assistantName, l) === draft.greeting.trim())
  if (!isDefault) return { ...draft, useCases, language }
  const greeting = greetingFor(name, assistantName, language)
  return { ...draft, useCases, language, greeting, greetingFrom: { text: greeting, name } }
}

/**
 * A proposal from the name alone (nothing looked up or read): the owner chooses the kind of business; a website typed
 * is kept as is.
 */
export function manualProposal(name: string, assistantName: string, website = '', language = 'en'): BusinessImportData {
  return {
    name: name.trim(),
    address: null,
    area: null,
    phone: null,
    website: website.trim() || null,
    hours: null,
    hoursText: [],
    timeZone: null,
    kind: null,
    template: null,
    services: [],
    about: '',
    useCases: [],
    greeting: greetingFor(name, assistantName, language),
    pages: [],
    notes: [],
    failures: [],
  }
}

/**
 * The common calls in saved instructions (instructionsOf writes them as "Common calls:", in German "Häufige Anrufe:",
 * and one "- " line each), in whichever language they were written.
 */
export function commonCallsOf(instructions: string | undefined): string[] {
  if (!instructions) return []
  for (const { commonCalls } of allAboutLabels) {
    const label = `${commonCalls}\n`
    const at = instructions.indexOf(label)
    if (at >= 0) return lines(instructions.slice(at + label.length).split('\n\n')[0] ?? '')
  }
  return []
}

/**
 * The template a saved profile was made with. It is not stored on its own (the kind is): the template whose default use
 * cases are most of the saved common calls (the review put them there when it was chosen), else the one the name
 * points to (templateFor), else null ("Choose…").
 */
export function savedTemplate(commonCalls: readonly string[], name: string): BusinessTemplateId | null {
  const saved = new Set(commonCalls)
  let best: { id: BusinessTemplateId; hits: number } | null = null
  for (const id of businessTemplateIds) {
    const hits = templateUseCasesAnyLanguage(id).filter(u => saved.has(u)).length
    if (hits > 0 && (!best || hits > best.hits)) best = { id, hits }
  }
  return best?.id ?? templateFor({ name })
}

/** Whether the business step was saved for this assistant: the profile has something the owner (or the agent) wrote. */
export const profileSaved = (profile: {
  instructions?: string | null
  phone?: string | null
  website?: string | null
  description?: string | null
}): boolean => !!(profile.instructions?.trim() || profile.phone || profile.website || profile.description)

/**
 * A proposal from the profile saved before (coming back to this step): the review starts from it, so saving again
 * keeps what was there, the kind of business included (savedTemplate).
 */
export function savedProposal(
  profile: BusinessProfile,
  name: string,
  greeting: string,
  kind: BusinessKind | null = null,
): BusinessImportData {
  const useCases = commonCallsOf(profile.instructions)
  const template = savedTemplate(useCases, name)
  return {
    // The kind saved, else the one the template stands for (a workspace from before kinds), for the owner to confirm.
    kind: kind ?? kindOfTemplate(template),
    name: name.trim(),
    address: profile.address ?? null,
    area: profile.service_area ?? null,
    phone: profile.phone ?? null,
    website: profile.website ?? null,
    hours: null,
    hoursText: [],
    timeZone: null,
    template,
    services: profile.services ?? [],
    about: profile.description ?? '',
    useCases,
    greeting,
    pages: [],
    notes: [],
    failures: [],
  }
}

/**
 * Another kind of business. When its template is another one, the old template's default use cases leave the list and
 * the new one's come first; lines the owner wrote or the website gave stay.
 */
export function switchKind(draft: ProfileDraft, kind: BusinessKind): ProfileDraft {
  const template = templateOfKind(kind)
  if (template === draft.template || !template) return { ...draft, kind }
  const old = new Set(draft.template ? templateUseCasesAnyLanguage(draft.template) : [])
  const kept = lines(draft.useCases).filter(l => !old.has(l))
  return { ...draft, kind, template, useCases: templateUseCases(template, kept, draft.language).join('\n') }
}

/**
 * A renamed business: the greeting follows when it named the business. Worked out from the greeting as proposed, not
 * from the last keystroke, so an emptied field keeps the proposed name and typing a name again puts in exactly it.
 */
export function renameBusiness(draft: ProfileDraft, name: string): ProfileDraft {
  const from = draft.greetingFrom
  if (!from.name || !from.text.includes(from.name)) return { ...draft, name }
  return { ...draft, name, greeting: from.text.split(from.name).join(name.trim() || from.name) }
}

/**
 * The About text the assistant answers from: the brief, then services, area, address and the common calls, with the
 * labels in the draft's language (aboutLabelsIn: German, else English).
 */
export function instructionsOf(draft: ProfileDraft): string {
  const services = lines(draft.services)
  const useCases = lines(draft.useCases)
  const label = aboutLabelsIn(draft.language)
  return [
    draft.about.trim(),
    services.length ? `${label.services} ${services.join('; ')}.` : null,
    draft.area.trim() ? `${label.area} ${draft.area.trim()}.` : null,
    draft.address.trim() ? `${label.address} ${draft.address.trim()}.` : null,
    useCases.length ? `${label.commonCalls}\n${useCases.map(u => `- ${u}`).join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, INSTRUCTIONS_MAX)
}

/** What is wrong with the draft, per field (shown under it); empty when it can be saved. */
export function draftProblems(draft: ProfileDraft): Partial<Record<'name' | 'kind' | 'phone' | 'website', string>> {
  const problems: Partial<Record<'name' | 'kind' | 'phone' | 'website', string>> = {}
  const name = draft.name.trim()
    ? workspaceNameProblem(draft.name, i18n())
    : i18n().t('onboarding.business.nameRequired')
  if (name) problems.name = name
  if (!draft.kind) problems.kind = i18n().t('onboarding.business.kindRequired')
  // The phone field's value is E.164 as far as typed: an unfinished number says so for its country.
  const phone =
    (draft.phone.trim().startsWith('+') ? phoneNumberProblem(draft.phone, i18n()) : null) ??
    businessPhoneProblem(draft.phone, i18n())
  if (phone) problems.phone = phone
  const website = businessWebsiteProblem(draft.website, i18n())
  if (website) problems.website = website
  return problems
}

/** Why the draft cannot be saved yet, or null. */
export function draftProblem(draft: ProfileDraft): string | null {
  return Object.values(draftProblems(draft))[0] ?? null
}

/** What saving writes: the assistant's greeting and profile; Google's hours only when the owner kept them. */
export function profileSave(
  draft: ProfileDraft,
  saved: BusinessProfile,
  workspaceName: string,
): {
  /** The greeting only when there is one: the next step asks for it, this one only names the business in it. */
  assistant: { greeting?: string; business_profile: BusinessProfile }
  hours: BusinessHoursSpan[] | null
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

/**
 * The time zone the step shows: the one the owner picked (Change), else the listing's (Google), else the workspace's.
 * Null while the workspace settings load and nothing else says.
 */
export const shownTimeZone = (picked: string | null, draft: Pick<ProfileDraft, 'timeZone'>, saved: string | null) =>
  picked ?? draft.timeZone ?? saved

/**
 * Another country picked: the time zone shown stays when it is in that country, else it becomes the country's main
 * zone (decision of 2026-11-17, LIN-433).
 */
export const zoneForCountry = (country: string, shown: string | null): string | null =>
  workspaceTimeZoneFor(country, shown)

/**
 * What the step saves of the time zone: the one shown, when it is not what the workspace will have anyway: its own,
 * or with a new country (`country`, saved with it) the zone the API moves a following time zone to (applyCountryDefaults).
 * A zone saved here is set by hand; one left out keeps following the country.
 */
export const timeZoneToSave = (
  shown: string | null,
  saved: string | null,
  country?: string | null,
  /** The saved zone follows the country (timeZoneFollowsCountry; missing from an older API: no). */
  follows = false,
): { timeZone?: string } => {
  const expected = country && follows ? (workspaceTimeZoneFor(country, saved) ?? saved) : saved
  return shown && shown !== expected ? { timeZone: shown } : {}
}
