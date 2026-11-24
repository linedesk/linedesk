// The page's language before anything paints (docs/translations.md): the last one this browser used, from what the
// app stores (src/i18n/locale.ts). A file, not inline: the Content-Security-Policy allows no inline scripts.
;(() => {
  try {
    const locale = window.localStorage.getItem('linedesk.locale')
    if (locale && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(locale)) {
      document.documentElement.lang = locale
      document.documentElement.dir = 'ltr'
    }
  } catch {
    // Private mode: index.html's lang="en" stays until the app starts.
  }
})()
