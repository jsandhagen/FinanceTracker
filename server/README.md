# Bank connection through Plaid

With this set up, FinanceTracker fetches new transactions from your bank by itself. CSV exports
keep working alongside it; a transaction that arrives both ways is kept once.

## The simple way: straight from the app

**Accounts → Bank connection**. Enter your Plaid **client_id** and **secret** (Plaid dashboard →
Developers → Keys), choose Production or Sandbox, press **Save**, then **Connect a bank**. Nothing
else to set up or run.

The keys are kept on that device only. They are not synced and not written to backups, and they
are sent to Plaid and nowhere else. The linked banks do sync, so a second device needs only the
same two keys.

One thing has to be done at Plaid, once: under **Developers → API → Allowed redirect URIs**, add
the app's full address with the trailing slash, such as `https://you.github.io/FinanceTracker/`.
Banks that sign you in on their own site (Capital One, Bank of America) send you back to it.

**Whether this works is up to Plaid, not the app.** A browser only lets a page read another
site's answer if that site allows it, and Plaid's API is built to be called from a server. Save
tests it: if the browser is refused, the app says so straight away. There are then two ways in,
and nothing about your data changes between them:

- **The Android app**, which is not a web page and so calls Plaid itself, with nothing to host.
  It is the simpler of the two if you have an Android phone: [android/README.md](../android/README.md).
  With sync on, what it fetches reaches the website on your other devices.
- **A relay**, below, for fetching from the browser itself.

## The fallback: a relay

A relay is one small file, `plaid-worker.js`, that holds your Plaid keys and makes the same calls
for the app. Cloudflare Workers runs it for free, and it can be set up in the browser with no
tools installed.

It stores nothing. When you link a bank, it encrypts that bank's access token with a key derived
from its own secrets and hands the sealed copy to the app, which sends it back with each request.
Your transactions pass through on their way to the browser and are not kept or logged.

1. Make up an access key: a long random string (a password manager's generator is fine, 30 or
   more characters). The app asks for it once per device.
2. At <https://dash.cloudflare.com>: **Workers & Pages → Create → Worker**, give it a name, and
   deploy the starter. Then **Edit code**, replace everything with the contents of
   `plaid-worker.js`, and **Deploy**.
3. In the Worker's **Settings → Variables and Secrets**, add:
   | Name | Value |
   | --- | --- |
   | `PLAID_CLIENT_ID` | from the Plaid dashboard (as a secret) |
   | `PLAID_SECRET` | from the Plaid dashboard (as a secret) |
   | `APP_KEY` | the access key from step 1 (as a secret) |
   | `PLAID_ENV` | `production`, or `sandbox` for Plaid's test bank |
   | `ALLOWED_ORIGIN` | where the app is served from, scheme and host only: `https://you.github.io` |
4. Add the redirect URI at Plaid, as described above.
5. In the app: **Accounts → Bank connection → a relay**. Enter the Worker's address
   (`https://<name>.<you>.workers.dev`) and the access key, press **Save**, then **Connect a bank**.

Prefer the command line? `wrangler.toml` is here: `npx wrangler deploy`, then
`npx wrangler secret put` for the three secrets.

If you switch between direct and relay, remove the linked banks and connect them again: a bank
linked one way cannot be opened the other.

## What to expect

- The first sync asks for up to two years of history. A bank can take a minute or two to hand it
  to Plaid; the app keeps checking and fills in when it arrives.
- After that the app fetches when it is opened or brought back to the front, at most every three
  hours, and whenever you press **Sync now**.
- Pending transactions are left out until they post.
- Plaid lists no balance after each transaction, so the app rebuilds the running balance of a
  checking or savings account from its current balance. The net worth chart is drawn from that.
- If a bank asks you to sign in again, the connection shows **Reconnect** with a **Sign in** button.
- **remove** ends the connection at Plaid, which also ends what Plaid bills for it. Transactions
  already in the app stay.

## More than one bank

Connect each bank separately with **Connect another bank**. A card at one bank that you pay from
an account at another, say a Bank of America card paid from Capital One checking, is handled like
this:

- What you buy on the card counts as spending, in its category, once.
- Paying the card is a transfer, not spending and not income, on both sides: the withdrawal from
  checking and the payment arriving on the card. Each side is recognised by its wording, and when
  one side is worded unclearly it is found by its other half (the same amount within a few days).
  If one slips through, tap its category and choose **Credit Card Payment**.
- The card's balance comes from the bank, so the net worth chart is right without typing a
  starting balance. The figure in Settings is only used for cards that are not connected.
- Only a Capital One card can be merged with a card from a CSV export. Purchases on another
  bank's card are never treated as duplicates of them, however alike two charges look.

## Changing the keys

With a relay, the sealed tokens are tied to `APP_KEY` and `PLAID_SECRET`. If you change either,
existing connections stop opening: remove them in the app and connect the banks again.

## Testing

`node tests/plaid.test.mjs` runs both the direct calls and the relay against a stand-in for Plaid's
API: no network, no keys.
