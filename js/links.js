// Shortcuts to an account's page on Capital One. The address holds an id that is
// different for every customer, so the app can only be given it, never work it out.

// Only https addresses on capitalone.com are accepted, so a saved link can never
// send you anywhere else. Returns the address or null.
export function cleanLink(raw) {
  try {
    const u = new URL(String(raw).trim());
    return u.protocol === 'https:' && /(^|\.)capitalone\.com$/i.test(u.hostname) ? u.href : null;
  } catch { return null; }
}

// A bank account's pages share one id: /Bank/<id>/transactions, /Bank/<id>/...
// Whichever of them was pasted, the one worth opening is the download form.
// Addresses of any other shape (a card, say) are kept exactly as pasted.
export function downloadLink(raw) {
  const href = cleanLink(raw);
  if (!href) return null;
  const u = new URL(href);
  const m = /^\/Bank\/([^/]+)(\/|$)/.exec(u.pathname);
  if (!m) return href;
  u.pathname = `/Bank/${m[1]}/downloadTransactions`;
  u.search = ''; u.hash = '';
  return u.href;
}
