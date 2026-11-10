// The relay between FinanceTracker and Plaid, as a Cloudflare Worker.
//
// Plaid's API needs your client id and secret, and neither may sit in a web
// page, so this small program holds them. It stores nothing: when a bank is
// linked, the bank's access token is encrypted with a key derived from this
// Worker's secrets and handed to the app, which sends it back with each
// request. Nobody holding the app's saved data can use it without this Worker.
//
// Secrets and settings (see server/README.md):
//   PLAID_CLIENT_ID, PLAID_SECRET   from the Plaid dashboard
//   PLAID_ENV                       "production" or "sandbox"
//   APP_KEY                         a long random string you make up; the app
//                                   sends it with every request
//   ALLOWED_ORIGIN                  where the app is served from, e.g.
//                                   https://you.github.io (comma-separated for several)

const enc = new TextEncoder(), dec = new TextDecoder();
const HISTORY_DAYS = 730; // the most Plaid offers
const MAX_PAGES = 40;     // 500 transactions a page

const json = (body, status, cors) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

function corsFor(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// Compared through a hash so the time taken says nothing about the key.
async function sameKey(a, b) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function sealKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`financetracker-seal|${env.APP_KEY}|${env.PLAID_SECRET}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(env), enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64(out);
}
async function unseal(env, sealed) {
  try {
    const raw = unb64(String(sealed));
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await sealKey(env), raw.slice(12)));
  } catch {
    throw new Fail(400, 'This bank connection was made with a different relay or access key. Remove it in the app and connect the bank again.', 'BAD_ITEM');
  }
}

class Fail extends Error {
  constructor(status, message, code = null) { super(message); this.status = status; this.code = code; }
}

async function plaid(env, path, body) {
  const host = env.PLAID_ENV === 'sandbox' ? 'sandbox.plaid.com' : 'production.plaid.com';
  const res = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Fail(502, data.error_message || `Plaid answered ${res.status}.`, data.error_code || null);
  return data;
}

// Only what the app uses leaves the Worker.
const slimTxn = t => ({
  transaction_id: t.transaction_id, account_id: t.account_id, date: t.date, authorized_date: t.authorized_date || null,
  name: t.name, merchant_name: t.merchant_name || null, original_description: t.original_description || null,
  amount: t.amount, pending: !!t.pending,
  personal_finance_category: t.personal_finance_category
    ? { primary: t.personal_finance_category.primary, detailed: t.personal_finance_category.detailed } : null,
});
const slimAcct = a => ({
  account_id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
  balances: { current: a.balances?.current ?? null, available: a.balances?.available ?? null },
});

const routes = {
  // A token that opens Plaid Link. With `item`, Link opens to repair that
  // connection (the bank asked for a fresh sign-in) rather than to add one.
  async 'link-token'(env, body, origins) {
    const user = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`user|${env.APP_KEY}`)))).slice(0, 32);
    const req = { client_name: 'FinanceTracker', language: 'en', country_codes: ['US'], user: { client_user_id: user } };
    if (body.item) req.access_token = await unseal(env, body.item);
    else { req.products = ['transactions']; req.transactions = { days_requested: HISTORY_DAYS }; }
    // Banks that sign in on their own site (Capital One among them) send you
    // back to this address. It must be one of this app's, and listed in the
    // Plaid dashboard under Developers > API > Allowed redirect URIs.
    if (body.redirect_uri) {
      let ok = false;
      try { ok = origins.includes(new URL(body.redirect_uri).origin); } catch {}
      if (!ok) throw new Fail(400, 'The return address is not on the allowed origin.');
      req.redirect_uri = body.redirect_uri;
    }
    const r = await plaid(env, '/link/token/create', req);
    return { link_token: r.link_token };
  },

  async exchange(env, body) {
    if (!body.public_token) throw new Fail(400, 'Missing public_token.');
    const r = await plaid(env, '/item/public_token/exchange', { public_token: body.public_token });
    return { item: await seal(env, r.access_token), item_id: r.item_id };
  },

  // Everything new since `cursor` (all history, the first time), and the
  // accounts with their current balances.
  async sync(env, body) {
    const access_token = await unseal(env, body.item);
    const start = body.cursor || null;
    for (let attempt = 0; ; attempt++) {
      const added = [], modified = [], removed = [];
      let cursor = start, more = true, pages = 0, accounts = null;
      try {
        while (more) {
          if (++pages > MAX_PAGES) throw new Fail(502, 'Too much history for one request. Sync again to continue.');
          const r = await plaid(env, '/transactions/sync', {
            access_token, count: 500, ...(cursor ? { cursor } : {}),
            options: { include_original_description: true, days_requested: HISTORY_DAYS },
          });
          added.push(...r.added.map(slimTxn));
          modified.push(...r.modified.map(slimTxn));
          removed.push(...r.removed.map(x => x.transaction_id));
          if (r.accounts) accounts = r.accounts;
          cursor = r.next_cursor;
          more = r.has_more;
        }
      } catch (e) {
        // Plaid's data moved while it was being paged through: start over once.
        if (e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt === 0) continue;
        throw e;
      }
      if (!accounts) accounts = (await plaid(env, '/accounts/get', { access_token })).accounts;
      return { added, modified, removed, cursor, accounts: accounts.map(slimAcct) };
    }
  },

  // Ends the connection at Plaid, which also ends its billing.
  async remove(env, body) {
    const access_token = await unseal(env, body.item);
    try { await plaid(env, '/item/remove', { access_token }); }
    catch (e) { if (e.code !== 'ITEM_NOT_FOUND') throw e; }
    return { removed: true };
  },
};

export default {
  async fetch(request, env) {
    const cors = corsFor(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json({ error: 'This origin is not allowed. Set ALLOWED_ORIGIN on the Worker to the address the app is served from.' }, 403, {});
    try {
      for (const k of ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'APP_KEY']) if (!env[k]) throw new Fail(500, `The Worker is missing its ${k} secret.`);
      if (request.method !== 'POST') throw new Fail(405, 'POST only.');
      const key = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!key || !(await sameKey(key, env.APP_KEY))) throw new Fail(401, 'Wrong access key.');
      const route = routes[new URL(request.url).pathname.split('/').filter(Boolean).pop() || ''];
      if (!route) throw new Fail(404, 'Unknown route.');
      const body = await request.json().catch(() => ({}));
      const origins = String(env.ALLOWED_ORIGIN).split(',').map(s => s.trim().replace(/\/+$/, ''));
      return json(await route(env, body || {}, origins), 200, cors);
    } catch (e) {
      if (e instanceof Fail) return json({ error: e.message, code: e.code }, e.status, cors);
      return json({ error: 'The relay failed unexpectedly.' }, 500, cors);
    }
  },
};
