<p align="center">
  <a href="https://jsandhagen.github.io/FinanceTracker/#install"><img src="icons/icon-192.png" width="96" height="96" alt="FinanceTracker" /></a>
</p>

<h1 align="center">FinanceTracker</h1>

<p align="center">
  <a href="https://jsandhagen.github.io/FinanceTracker/#install"><img src="https://img.shields.io/badge/Install%20the%20app-8b5cf6?style=for-the-badge" alt="Install the app" height="40" /></a>
  &nbsp;
  <a href="https://jsandhagen.github.io/FinanceTracker/"><img src="https://img.shields.io/badge/Open%20in%20browser-1e293b?style=for-the-badge" alt="Open in browser" height="40" /></a>
  &nbsp;
  <a href="https://github.com/jsandhagen/FinanceTracker/releases/download/android-latest/FinanceTracker.apk"><img src="https://img.shields.io/badge/Android%20app%20(APK)-3ddc84?style=for-the-badge" alt="Download the Android app" height="40" /></a>
</p>

<p align="center"><sub>Opens the app with install steps for your device: one tap on Android, Windows and Mac (Chrome/Edge), Share → Add to Home Screen on iPhone.<br />
The <b>Android app</b> is the full app with a direct bank connection: download it on the phone, install it, then add your Plaid keys under <b>Accounts → Bank connection</b>. <a href="android/README.md">Set-up steps</a>.</sub></p>

---

A private spending dashboard for Capital One CSV exports (360 Checking, 360 Savings, credit card).
It runs entirely in the browser, installs as an app on a phone or computer, and works offline.

- **One console, grouped by money in and money out.** Overview (net worth, income, spending,
  savings rate, each against the period before) and Cash flow (a flow-of-funds diagram and a
  month-by-month table) on top. **Money in:** Income, by source, with Salary & raises under it.
  **Money out:** Spending (categories, trend, a daily heatmap, merchants, weekdays) with Budgets
  under it, and Recurring (detected bills and paychecks with their next expected date).
  **Records:** the Transactions ledger (search, sort, filter, export to CSV) and Accounts.
- **Outlook: where the balance is heading, and the room for a big spend.** Checking less what is
  owed on the card, carried 30, 60 or 90 days forward: detected bills, paychecks and regular
  transfers on their dates, plus everyday spending at its recent rate. Travel is left out of that
  rate, so **Room for a big spend** is what a trip (or any one-off) can cost while the balance
  stays above the amount you choose to keep. Try an amount and a date to see it on the forecast.
  Runway shows how many months your money covers at usual spending and on essentials alone.
- **Income by source.** Every deposit that counts as income is grouped by who paid it, and each
  source has a type: Salary, Side income, Reimbursements (Venmo and the like: people paying you
  back), Interest or Other. Types are guessed (your main paycheck and its employer are Salary,
  payroll from anyone else is Side income) and you can change them, and give a source a name.
- **Being paid back is not income.** Deposits from a source typed Reimbursements come off your
  spending, in their own **Paid back** line, since which purchase they cover is not known. File
  one under a category (tap its category in the ledger) and it comes off that category instead.
- **Salary tracker and "what if".** Enter your salary, how often you are paid, and your bonus and
  the month it lands. Salary & raises works out federal tax, Social Security, Medicare and
  **Virginia** income tax, then backs your own rates out of the take-home you actually receive
  (read from your deposits, or typed in): whatever the tax tables do not explain is treated as
  money taken out before tax. Type a raise, as a percentage, an amount or a new salary, to see
  what you keep of it, how each tax moves, and what it does to your savings rate. Its
  month-by-month tracking counts only sources typed Salary.
- **Optional bank connection through Plaid**, so new transactions arrive without downloading
  anything. The [Android app](android/README.md) connects by itself, with nothing to host; a
  browser needs a small relay ([server/README.md](server/README.md)).
- **Fast to get around.** `Ctrl`/`⌘` + `K` opens a command palette for views, periods,
  categories and merchants; `1`–`7` switch views. Tap any transaction for its detail and the
  merchant's history. The side rail collapses to icons.
- **Try it first.** "Explore with demo data" on the first screen loads synthetic accounts.
  Nothing from the demo is saved.
- **Your data stays on your device.** CSVs are read in the browser and saved in its local
  storage (IndexedDB). Nothing is uploaded anywhere unless you turn on sync.
- **Upload once, then just add.** New exports are merged in and transactions already saved are
  skipped, so overlapping date ranges are fine.
- **Refreshing is one click.** The top bar shows how old the data is; **Refresh data** shows how
  far behind each account is and what date range to export. In Chrome or Edge on a computer the
  app can watch your downloads folder and import new exports by itself (see below).
- **Trips are Travel.** Airbnb, Vrbo, hotels, rental cars (Sixt, Enterprise, Hertz, Avis…),
  airlines, booking sites and Capital One Travel are filed under Travel by name, whatever the card
  or bank called them. A Capital One travel credit comes off Travel. Grocery stores (Trader Joe's,
  Whole Foods, Aldi, Giant, Safeway, Wegmans, Instacart…) are Groceries the same way, except their
  gas pumps and pharmacies; Target, Walmart and Costco stay Shopping.
- **Brands are filed by name on cards too.** Streaming services, restaurant chains, gas brands,
  utilities, insurers, pharmacies and gyms land in the same category whether they were paid by card
  or from checking, and whether the data came from a CSV or Plaid. A card's own specific category
  (a Walmart run it calls Grocery) is kept.
- **Money that is not spending or income is kept out.** Contributions to Vanguard, Fidelity,
  Schwab, Robinhood and the like are Investment Transfers. A PayPal purchase counts as spending,
  and only a PayPal transfer to a person is a transfer. Affirm, Klarna and Afterpay payments
  count as Shopping, because they are the only record of what was bought. ATM cash counts as
  spending (Other).
- **Refunds are not income.** Money back on a card comes off spending in its category. Payments
  to the card and moves between your own accounts count as neither income nor spending.
- **Rules stick.** Tap a category in the transactions table to recategorize a merchant (or one
  amount, with a tolerance). Rules apply to past and future uploads, and also teach the
  auto-categorizer.
- **Optional sync** between devices through a secret GitHub Gist, **encrypted in the browser**
  (AES-GCM, key derived from your passphrase) so GitHub only stores ciphertext.

## Publish it with GitHub Pages

1. Create a new repository on GitHub (it can be private if your plan includes Pages for
   private repos; otherwise public is fine, since the repo holds code, never data).
2. Push this folder:
   ```bash
   git remote add origin https://github.com/<you>/FinanceTracker.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   (Not "Deploy from a branch": the workflow in `.github/workflows/deploy.yml` stamps each
   deploy with a version, which is what makes installed copies update themselves.)
4. After a minute (watch the **Actions** tab) it is live at `https://<you>.github.io/FinanceTracker/`.

## Install it

- **iPhone / iPad:** open the link in Safari → Share → **Add to Home Screen**.
- **Android:** open in Chrome → ⋮ menu → **Install app** (or *Add to Home screen*).
- **Windows / Mac:** open in Chrome or Edge → install icon in the address bar
  (or ⋮ → *Cast, save and share* → *Install page as app*).

Install it rather than only bookmarking it: Safari may clear storage for websites you have not
visited in a while, but not for apps on the home screen.

### As a native Android app

There is also an Android build of the same code, for connecting to your bank through Plaid with
no server in between.

1. On the phone, download **[FinanceTracker.apk](https://github.com/jsandhagen/FinanceTracker/releases/download/android-latest/FinanceTracker.apk)** and open it. Android asks once to allow
   installs from Chrome (or your file manager): allow it, then **Install**.
2. Open the app, go to **Accounts → Bank connection**, enter your Plaid **client_id** and
   **secret**, and press **Save**. They are encrypted on the phone and sent only to Plaid.
3. **Connect a bank.**

Before step 3, the app's package name has to be registered in the Plaid dashboard, and a signing
key has to be set up once so updates install over the app without losing its data. Both are in
[android/README.md](android/README.md).

## Salary & raises

The figures are estimates for tax year 2026, built from the federal brackets and standard
deduction, Social Security and Medicare, and Virginia's rates, standard deduction and personal
exemption (`js/tax.js`; update that one file each year). Credits, itemized deductions and other
income are not modelled, which is what calibrating against your real take-home is for:

- If your paycheck is **smaller** than the tables predict, the gap is treated as a share of pay
  taken out before income tax (a 401(k), health premiums) and is applied to the bonus and to a
  raise as well.
- If it is **larger**, nothing is assumed to come out before tax and your income tax is scaled
  down to match.

A bonus is taxed as what it adds to the year's bill, on top of the salary. Employers usually
withhold a flat rate on the day and the difference is settled when you file. "This year" compares
the deposits from sources typed Salary with what the plan expects on each payday.

## Refreshing your data

The hands-off way is a bank connection through Plaid: from the [Android app](android/README.md)
directly, or from a browser through a [relay](server/README.md). Without one, the export
is a click on Capital One's site, and everything after that click can be automatic:

1. **Refresh data → Choose a folder to watch** (Chrome or Edge on a computer) and pick the folder
   your downloads are saved to. If the browser refuses the Downloads folder itself, make a folder
   inside it and save exports there.
2. From then on: download the CSVs from Capital One, come back to the app. They are already in.
   The app looks in the folder when it opens, when you return to it, and every 20 seconds while
   it is on screen. It reads each CSV once and keeps only Capital One exports.
3. The browser may ask for the folder again on a later visit (the button reads **Reconnect
   folder**). Choose *Allow on every visit* and it stops asking.

To cut out the clicking around on Capital One: open an account there, copy the address from the
address bar, and save it under **Refresh data → Add link**. Any page of the account will do: the
app turns it into that account's download page, and each account then has a button that opens it, and **Open all** opens every one in its own tab.

All of this lives on the **Accounts** tab (`7`), with each account's balance, how far behind it is,
and its download link.

**On Android**, Chrome saves downloads in its own private folder, which the app cannot read. Install
the app, then in Chrome open **⋮ → Downloads**, press and hold the CSV, **Share → FinanceTracker**.

Other ways in: drop files anywhere on the dashboard; on a computer with the app installed,
**Open with → FinanceTracker**. With sync on, a file imported on one device shows up on the other.

Overlapping date ranges are safe: a transaction already saved is skipped.

## Sync between phone and computer (optional)

1. Create a token at <https://github.com/settings/tokens/new?scopes=gist> with only the
   **gist** scope.
2. In the app: **Settings → Sync between devices**, paste the token and choose a passphrase.
3. On the other device, enter the **same token and passphrase**. It finds the gist and pulls
   everything down.

After that each device syncs on open, when it comes back to the foreground, and after every
change. If you forget the passphrase the synced copy cannot be decrypted, but each device keeps
its own local copy. Settings → **Download backup** writes a plain JSON file you can keep as well.

## Bringing over rules from the Flask version

Settings → **Import custom_rules.json / training_data.json** and pick both files from the old
`FinanceTracker` folder.

## Development

No build step. Serve the folder and open it:

```bash
python -m http.server 8000
```

Tests (Node 20+). The parity test runs the original Python `analyzer.py` and this port over the
same synthetic exports and checks that totals, every category, the recurring streams and the
assets series agree:

```bash
npm test    # every tests/*.test.mjs
```

```bash
python tests/make_fixtures.py /tmp/fx
echo '{"merchant": {}, "amount_rules": []}' > /tmp/rules.json
python tests/run_python.py ../FinanceTracker /tmp/fx /tmp/rules.json /tmp/py.json
node tests/parity.mjs /tmp/fx /tmp/py.json /tmp/rules.json
node tests/analyzer.test.mjs
node tests/sync.test.mjs
node tests/insights.test.mjs
node tests/income.test.mjs
node tests/plaid.test.mjs
```

Deliberate differences from the Python version: the auto-categorizer (scikit-learn's logistic
regression became a nearest-neighbour match over the same TF-IDF character n-grams in
`js/categorizer.js`, which needs no training step in the browser), and trips (lodging, rental cars,
flights, Capital One Travel) and grocery stores are filed by name on every row (`TRAVEL_KEYWORDS`
and `GROCERY_KEYWORDS` in `js/analyzer.js`), where the Python version followed the card's own
category. Fixtures with
rental cars or travel-named merchants will differ in the parity test for that reason.

### Shipping a change

Commit and push to `main`. That is all: the **Deploy** workflow runs the tests, stamps the
commit into `sw.js` and `js/version.js`, and publishes. Every installed copy then updates
itself. It checks when opened, when brought back to the foreground and every 30 minutes,
and reloads onto the new version straight away, unless you are mid-task (a sheet open,
typing, a sync running), in which case it shows **Update ready · Reload** and updates the
next time the app is put away. Data lives in browser storage, not in the app's files, so
updates never touch it. **Settings → App version** shows which commit is running and has a
**Check for updates** button.

If the tests fail the deploy stops and the live app stays as it was. A new file the app loads
must be added to `SHELL` in `sw.js` so it is available offline.

`package.json`, `capacitor.config.json` and `android/` exist only to package the Android app
([android/README.md](android/README.md)); the website still has no build step and does not use
them. A new file the app loads is picked up by the Android build by itself if it sits in `js/`,
`css/`, `vendor/` or `icons/` (`tools/build-www.mjs`).

`vendor/chart.umd.min.js` is Chart.js 4.4.3 (MIT), vendored so the app works offline.
