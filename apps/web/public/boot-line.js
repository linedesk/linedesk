// The boot line of index.html in the reader's language (vite.config.ts, bootLines): `?lang=`, else the language this
// browser last used (src/i18n/locale.ts), else its own languages, else English as written. A file, not inline: the
// Content-Security-Policy allows no inline scripts.
;(() => {
  try {
    const line = document.querySelector('.boot-static[data-lines]')
    const lines = line && JSON.parse(line.getAttribute('data-lines') || '{}')
    if (!lines) return
    const wanted = [
      new URLSearchParams(window.location.search).get('lang'),
      window.localStorage.getItem('linedesk.locale'),
    ]
      .concat(navigator.languages || [navigator.language])
      .filter(Boolean)
    for (const tag of wanted) {
      const base = tag.split('-')[0].toLowerCase()
      const match = lines[tag] ? tag : Object.keys(lines).find(locale => locale.split('-')[0].toLowerCase() === base)
      if (match) {
        line.textContent = lines[match]
        return
      }
    }
  } catch {
    // Private mode or a page without the lines: the English line stays.
  }
})()
