// Adding a passkey for this device: Account › Sign-in & security (index.tsx, Passkeys) and the agent setup page
// (onboarding/AgentSetup.tsx) run the same registration, with the same name, enrolment code and errors.
import { useState } from 'react'
import { useQuery } from '../../cachedQuery.ts'
import { readEnrolmentCode } from '../../enrolment-code.ts'
import { authErrorMessage } from '../../sign-in-code.ts'
import { addPasskeyForThisDevice, loadPasskeyEnrolment, PASSKEY_ENROLMENT } from './account-api.ts'

/** The words addPasskey (via addPasskeyForThisDevice) throws when the person closed the browser's passkey prompt. */
export const PASSKEY_ADD_CANCELLED = authErrorMessage({ code: 'ERROR_CEREMONY_ABORTED' })

/** Whether an error from adding a passkey only means the person closed the prompt (nothing failed). */
export const passkeyAddCancelled = (err: unknown) => err instanceof Error && err.message === PASSKEY_ADD_CANCELLED

export function useAddPasskey() {
  const enrolment = useQuery(PASSKEY_ENROLMENT, loadPasskeyEnrolment)
  // The first admin's code came back with the setup (enrolment-code.ts): filled in, so adding the passkey is one click.
  const [enrolmentCode, setEnrolmentCode] = useState(() => readEnrolmentCode() ?? '')
  // Asked at the click when the cached answer is not there: a page without a workspace (the setup pages) has its
  // cached answers forgotten right after it opens (localData.ts forgetBeyond), so useQuery may never answer there.
  const [askedAtAdd, setAskedAtAdd] = useState<boolean | undefined>(undefined)
  // An instance admin's first passkey needs the one-time code another admin (or the CLI) gave them.
  const needsCode = (enrolment.data ?? askedAtAdd) === true

  /**
   * Asks the browser to make a passkey for this device; throws in the app's words (SignInAgain, ConfirmWithPasskey or
   * an Error). `reloadToo` is read again together with whether a code is still needed.
   */
  const addThisDevice = async (reloadToo?: () => Promise<unknown>) => {
    let codeNeeded = needsCode
    if (enrolment.data === undefined) {
      codeNeeded = await loadPasskeyEnrolment()
      setAskedAtAdd(codeNeeded)
    }
    if (codeNeeded && !enrolmentCode.trim()) throw new Error('Enter your passkey enrolment code first.')
    // Names it after this device, uses up a remembered code and remembers the passkey as this device's way in.
    await addPasskeyForThisDevice(codeNeeded ? enrolmentCode : undefined)
    setEnrolmentCode('')
    setAskedAtAdd(undefined)
    await Promise.all([reloadToo?.(), enrolment.reload()])
  }

  return {
    needsCode,
    enrolmentCode,
    setEnrolmentCode,
    addThisDevice,
  }
}
