# Bank connection through Plaid

With this set up, FinanceTracker fetches new transactions from your bank by itself. CSV exports
keep working alongside it; a transaction that arrives both ways is kept once.

## Why there is a server at all

The rest of the app is a web page with no server. Plaid cannot work that way: its API needs your
client id and secret, which must never sit in a web page, and it does not answer requests from
browsers. So the keys live in a small relay, `plaid-worker.js`, that you host yourself. Cloudflare
Workers runs it for free.

The relay stores nothing. When you link a bank, Plaid issues an access token for it; the relay
encrypts that token with a key derived from its own secrets and hands the sealed copy to the app.
The app keeps it with your settings (so it syncs to your other devices) and sends it back each
time it asks for transactions. Without the relay and your access key, the sealed token is useless.
Your transactions pass through the relay on their way to the browser and are not kept or logged.

## Set-up, about ten minutes

You need your Plaid **client id** and **secret** (Plaid dashboard → Developers → Keys) and a free
Cloudflare account.

1. Make up an access key: a long random string. For example:
   ```bash
   openssl rand -base64 32
   ```
   Keep it somewhere safe. The app will ask for it once per device.
2. In `server/wrangler.toml`, set `ALLOWED_ORIGIN` to where your copy of the app is served from
   (scheme and host only, such as `https://you.github.io`) and `PLAID_ENV` to `production`, or
   `sandbox` to try it with Plaid's test bank first.
3. Deploy, from this folder:
   ```bash
   cd server
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put PLAID_CLIENT_ID
   npx wrangler secret put PLAID_SECRET
   npx wrangler secret put APP_KEY        # the access key from step 1
   ```
   `deploy` prints the relay's address, like `https://financetracker-plaid.<you>.workers.dev`.
4. In the Plaid dashboard, under **Developers → API → Allowed redirect URIs**, add the app's full
   address, with the trailing slash: `https://you.github.io/FinanceTracker/`. Banks that sign you
   in on their own site, Capital One among them, send you back to it. On a phone this is required.
5. In the app: **Accounts → Bank connection**. Enter the relay address and the access key, press
   **Save**, then **Connect a bank**.

A second device needs only step 5. If sync is on, the linked banks are already there once you have
entered the relay address and key.

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

## Changing the keys

The sealed tokens are tied to `APP_KEY` and `PLAID_SECRET`. If you change either, existing
connections stop opening: remove them in the app and connect the banks again.

## Testing

`node tests/plaid.test.mjs` runs the relay against a stand-in for Plaid's API: no network, no keys.
