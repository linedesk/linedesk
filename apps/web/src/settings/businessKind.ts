// The kind of business as a pick list (LIN-680): onboarding's business step and Workspace settings › General. The kinds
// and their groups are @linedesk/actions' (business-kind.ts); their names are in common.json (businessKind.*).
import { type BusinessKind, type BusinessKindGroup, businessKindInfo, businessKinds } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { i18n } from '../i18n/index.tsx'
import type { SelectOption } from '../ui/controls.tsx'

const KIND_LABEL: Record<BusinessKind, MessageKey> = {
  plumbing_hvac: msg('common.businessKind.kind.plumbing_hvac'),
  electrical: msg('common.businessKind.kind.electrical'),
  roofing_construction: msg('common.businessKind.kind.roofing_construction'),
  cleaning: msg('common.businessKind.kind.cleaning'),
  landscaping: msg('common.businessKind.kind.landscaping'),
  pest_control: msg('common.businessKind.kind.pest_control'),
  locksmith: msg('common.businessKind.kind.locksmith'),
  home_services: msg('common.businessKind.kind.home_services'),
  dental: msg('common.businessKind.kind.dental'),
  medical: msg('common.businessKind.kind.medical'),
  therapy: msg('common.businessKind.kind.therapy'),
  veterinary: msg('common.businessKind.kind.veterinary'),
  salon_spa: msg('common.businessKind.kind.salon_spa'),
  fitness: msg('common.businessKind.kind.fitness'),
  law_office: msg('common.businessKind.kind.law_office'),
  accounting_tax: msg('common.businessKind.kind.accounting_tax'),
  insurance: msg('common.businessKind.kind.insurance'),
  real_estate: msg('common.businessKind.kind.real_estate'),
  agency_consulting: msg('common.businessKind.kind.agency_consulting'),
  auto_repair: msg('common.businessKind.kind.auto_repair'),
  restaurant: msg('common.businessKind.kind.restaurant'),
  hotel_lodging: msg('common.businessKind.kind.hotel_lodging'),
  online_store: msg('common.businessKind.kind.online_store'),
  retail_store: msg('common.businessKind.kind.retail_store'),
  education: msg('common.businessKind.kind.education'),
  other: msg('common.businessKind.kind.other'),
}
const GROUP_LABEL: Record<BusinessKindGroup, MessageKey> = {
  trades: msg('common.businessKind.group.trades'),
  health: msg('common.businessKind.group.health'),
  beauty_fitness: msg('common.businessKind.group.beauty_fitness'),
  professional: msg('common.businessKind.group.professional'),
  auto: msg('common.businessKind.group.auto'),
  food_stay: msg('common.businessKind.group.food_stay'),
  retail: msg('common.businessKind.group.retail'),
  education: msg('common.businessKind.group.education'),
  other: msg('common.businessKind.group.other'),
}

export const kindLabel = (kind: BusinessKind) => i18n().t(KIND_LABEL[kind])

/** Every kind under its group's heading, in list order. Built when shown, never at import (that would freeze English). */
export const kindOptions = (): SelectOption<BusinessKind>[] =>
  businessKinds.map(kind => ({
    value: kind,
    label: kindLabel(kind),
    group: i18n().t(GROUP_LABEL[businessKindInfo[kind].group]),
  }))
