// A partner (owner or partner admin) setting up a CLIENT workspace: the onboarding's step texts
// speak about the client ("Client's business", "Client's assistant"), not "your …". The client's own owner still reads
// "Your …". Who is who: /v1/me's workspace.viaPartner (#1273).
import { type MessageKey, msg } from '@linedesk/i18n'
import { createContext, type ReactNode, useContext } from 'react'

/** The step texts that say "your …", and how they read for someone setting the workspace up for a client. */
export const CLIENT_WORDS: ReadonlyMap<MessageKey, MessageKey> = new Map([
  [msg('onboarding.steps.business'), msg('onboarding.steps.businessClient')],
  [msg('onboarding.steps.assistant'), msg('onboarding.steps.assistantClient')],
  [msg('onboarding.business.heading'), msg('onboarding.business.headingClient')],
  [msg('onboarding.business.manual.namePlaceholder'), msg('onboarding.business.manual.namePlaceholderClient')],
  [msg('onboarding.business.review.isThisYours'), msg('onboarding.business.review.isThisYoursClient')],
  [msg('onboarding.business.review.aboutYours'), msg('onboarding.business.review.aboutYoursClient')],
  [msg('onboarding.business.lede.saved'), msg('onboarding.business.lede.savedClient')],
  [msg('onboarding.business.lede.listing'), msg('onboarding.business.lede.listingClient')],
  [msg('onboarding.business.lede.listingAndWebsite'), msg('onboarding.business.lede.listingAndWebsiteClient')],
  [msg('onboarding.business.lede.manual'), msg('onboarding.business.lede.manualClient')],
  [msg('onboarding.assistant.heading'), msg('onboarding.assistant.headingClient')],
  [msg('onboarding.pickup.lede'), msg('onboarding.pickup.ledeClient')],
  [msg('onboarding.pickup.noAnswer.title'), msg('onboarding.pickup.noAnswer.titleClient')],
  [msg('onboarding.pickup.afterHours.title'), msg('onboarding.pickup.afterHours.titleClient')],
  [msg('onboarding.pickup.afterHours.description'), msg('onboarding.pickup.afterHours.descriptionClient')],
  // Who hears about calls: the summaries are the signed-in member's own (the partner's), the urgent calls the client's.
  [msg('onboarding.notify.lede'), msg('onboarding.notify.ledeClient')],
  [msg('onboarding.notify.message.title'), msg('onboarding.notify.message.titleClient')],
  [msg('onboarding.notify.message.description'), msg('onboarding.notify.message.descriptionClient')],
  [msg('onboarding.notify.transfer.title'), msg('onboarding.notify.transfer.titleClient')],
  [msg('onboarding.notify.transfer.description'), msg('onboarding.notify.transfer.descriptionClient')],
  [msg('onboarding.notify.mobile.label'), msg('onboarding.notify.mobile.labelClient')],
  [msg('onboarding.flow.option.forward.title'), msg('onboarding.flow.option.forward.titleClient')],
  [msg('onboarding.flow.option.forward.description'), msg('onboarding.flow.option.forward.descriptionClient')],
  [msg('onboarding.flow.option.new.title'), msg('onboarding.flow.option.new.titleClient')],
  [msg('onboarding.flow.option.new.description'), msg('onboarding.flow.option.new.descriptionClient')],
  [msg('onboarding.flow.option.existing.description'), msg('onboarding.flow.option.existing.descriptionClient')],
  [msg('onboarding.phone.connected.keepAll'), msg('onboarding.phone.connected.keepAllClient')],
  [msg('onboarding.phone.connected.keepMissed'), msg('onboarding.phone.connected.keepMissedClient')],
  [msg('onboarding.phone.connected.onlyNew'), msg('onboarding.phone.connected.onlyNewClient')],
  [msg('onboarding.phone.connected.forwardAllToo'), msg('onboarding.phone.connected.forwardAllTooClient')],
  [msg('onboarding.phone.connected.forwardMissedToo'), msg('onboarding.phone.connected.forwardMissedTooClient')],
  [msg('onboarding.phone.connected.carrier'), msg('onboarding.phone.connected.carrierClient')],
  [msg('onboarding.phone.connected.pickCarrier'), msg('onboarding.phone.connected.pickCarrierClient')],
  [msg('onboarding.forwardingCheck.numberLabel'), msg('onboarding.forwardingCheck.numberLabelClient')],
  [msg('onboarding.forwardingCheck.numberTip'), msg('onboarding.forwardingCheck.numberTipClient')],
  [msg('onboarding.forwardingCheck.enterNumber'), msg('onboarding.forwardingCheck.enterNumberClient')],
  [msg('onboarding.flow.done.answersOnceConnected'), msg('onboarding.flow.done.answersOnceConnectedClient')],
  [msg('onboarding.flow.done.connectNumber'), msg('onboarding.flow.done.connectNumberClient')],
  [msg('onboarding.phone.choose.titleAll'), msg('onboarding.phone.choose.titleAllClient')],
  [msg('onboarding.phone.choose.titleMissed'), msg('onboarding.phone.choose.titleMissedClient')],
  [msg('onboarding.phone.choose.ledeMissed'), msg('onboarding.phone.choose.ledeMissedClient')],
  [msg('onboarding.phone.connected.titleAll'), msg('onboarding.phone.connected.titleAllClient')],
  [msg('onboarding.phone.connected.titleMissed'), msg('onboarding.phone.connected.titleMissedClient')],
  [msg('onboarding.phone.connected.titleReady'), msg('onboarding.phone.connected.titleReadyClient')],
])

/** `key` as it reads for a client workspace set up through its partner, or as it is. */
export const clientWord = (key: MessageKey, forClient: boolean): MessageKey =>
  forClient ? (CLIENT_WORDS.get(key) ?? key) : key

const ForClientContext = createContext(false)

export function ForClient({ value, children }: { value: boolean; children: ReactNode }) {
  return <ForClientContext.Provider value={value}>{children}</ForClientContext.Provider>
}

/** Whether a partner's team sets this workspace up for its client. */
export const useForClient = (): boolean => useContext(ForClientContext)

/** The key for this onboarding: a partner's team sees the client's words (CLIENT_WORDS). */
export function useClientWord(): (key: MessageKey) => MessageKey {
  const forClient = useContext(ForClientContext)
  return key => clientWord(key, forClient)
}
