// The German BNetzA form (Telnyx's "Confirmation of local relationship to area code"), prefilled with the business's
// details for the owner to sign and upload (docs/numbers-kyc.md). Made in the browser: the details never leave it
// for this. The template is Telnyx's public support attachment (assets/telnyx-germany-registration-form.pdf, two
// pages, no form fields): the text goes onto page 2 at the places of its checkboxes and signature lines. pdf-lib is
// loaded only when the form is asked for.
import type { RegulatoryEntityType } from '@linedesk/actions'
import templateUrl from './assets/telnyx-germany-registration-form.pdf?url'

export type BnetzaFill = {
  legalName: string
  /** The register number and court ("HRB 751915, Amtsgericht Mannheim"), next to "certificate of registration"; '' for none. */
  register: string
  /** The person who signs (the contact): under the signature line. */
  signer: string
  /** The place of business ("Dossenheim"), before the date. */
  place: string
  /** The date as the reader writes it. */
  date: string
  /** A company ticks its certificate of registration; a sole trader or an individual the identity card. */
  entityType: RegulatoryEntityType
}

/** Where on page 2 (PDF points from the bottom left) each part goes; read from the template's own text. */
const PAGE2 = {
  companyRegistration: { x: 72.5, y: 690.5 },
  // After the words "certificate of registration" on the same line (the form has no line of its own for it).
  register: { x: 214, y: 690.5 },
  identityCard: { x: 72.5, y: 533 },
  legalName: { x: 345.6, y: 336 },
  // The template's own line on the left (no label): the place and date go on it.
  placeDate: { x: 90, y: 329 },
  placeDateLabel: { x: 90, y: 313 },
  signer: { x: 345.6, y: 282 },
}

/** The prefilled form as a PDF. */
export async function bnetzaFormPdf(fill: BnetzaFill): Promise<Blob> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const template = await fetch(templateUrl).then(r => {
    if (!r.ok) throw new Error(`form template: HTTP ${r.status}`)
    return r.arrayBuffer()
  })
  const pdf = await PDFDocument.load(template)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.getPage(1)
  const ink = rgb(0.1, 0.1, 0.1)
  const text = (value: string, at: { x: number; y: number }, size = 11) =>
    page.drawText(value, { x: at.x, y: at.y, size, font, color: ink })

  text('X', fill.entityType === 'business' ? PAGE2.companyRegistration : PAGE2.identityCard)
  if (fill.entityType === 'business' && fill.register) text(fill.register, PAGE2.register, 9)
  text(fill.legalName, PAGE2.legalName)
  text([fill.place, fill.date].filter(Boolean).join(', '), PAGE2.placeDate)
  // i18n-ignore: a label on Telnyx's English form, which the carrier reads; not text of the app
  text('Place, date', PAGE2.placeDateLabel, 8)
  text(fill.signer, PAGE2.signer, 9)
  pdf.setTitle(fill.legalName)
  const bytes = await pdf.save()
  return new Blob([bytes.slice().buffer], { type: 'application/pdf' })
}

/** Saves the prefilled form as a file. */
export async function downloadBnetzaForm(fill: BnetzaFill, filename: string): Promise<void> {
  const url = URL.createObjectURL(await bnetzaFormPdf(fill))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
