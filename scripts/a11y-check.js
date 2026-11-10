// Paste into the page: a small accessibility check (names, contrast, roles, landmarks).
;(() => {
  const accName = el =>
    el.getAttribute('aria-label') ||
    (el.getAttribute('aria-labelledby') && 'labelledby') ||
    el.textContent.trim() ||
    el.getAttribute('title') ||
    (el.labels?.length ? 'label' : '')
  const unnamed = [
    ...document.querySelectorAll(
      'button, [role=button], a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=slider], [role=option]',
    ),
  ]
    .filter(el => !accName(el))
    .map(el => el.outerHTML.slice(0, 140))
  const parse = c => (c.match(/[\d.]+/g) || []).map(Number)
  const lum = c => {
    const [r, g, b] = parse(c)
      .slice(0, 3)
      .map(v => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const bgOf = el => {
    for (let e = el; e; e = e.parentElement) {
      const b = getComputedStyle(e).backgroundColor
      const alpha = parse(b)[3]
      if (b && b !== 'transparent' && alpha !== 0) return b
    }
    return 'rgb(255, 255, 255)'
  }
  const low = []
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden=true], .sr-only')) continue
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) continue
    const a = lum(cs.color),
      b = lum(bgOf(el))
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700)
    if (ratio < (large ? 3 : 4.5))
      low.push(
        `${ratio.toFixed(2)} ${cs.color} on ${bgOf(el)} "${el.textContent.trim().slice(0, 30)}" .${String(el.className).slice(0, 40)}`,
      )
  }
  const dialogs = [...document.querySelectorAll('.k-cmd, .help-sheet')].map(
    d =>
      `${d.className}: role=${d.getAttribute('role')} modal=${d.getAttribute('aria-modal')} label=${d.getAttribute('aria-label')}`,
  )
  return {
    unnamed,
    low: [...new Set(low)].slice(0, 30),
    h1: document.querySelectorAll('h1').length,
    main: document.querySelectorAll('main').length,
    lists: document.querySelectorAll('[role=list]').length,
    dialogs,
  }
})()
