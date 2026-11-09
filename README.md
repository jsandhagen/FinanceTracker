<p align="center">
  <a href="https://jsandhagen.github.io/FinanceTracker/#install"><img src="icons/icon-192.png" width="96" height="96" alt="FinanceTracker" /></a>
</p>

<h1 align="center">FinanceTracker</h1>

<p align="center">
  <a href="https://jsandhagen.github.io/FinanceTracker/#install"><img src="https://img.shields.io/badge/Install%20the%20app-8b5cf6?style=for-the-badge" alt="Install the app" height="40" /></a>
  &nbsp;
  <a href="https://jsandhagen.github.io/FinanceTracker/"><img src="https://img.shields.io/badge/Open%20in%20browser-1e293b?style=for-the-badge" alt="Open in browser" height="40" /></a>
</p>

<p align="center"><sub>Opens the app with install steps for your device: one tap on Android, Windows and Mac (Chrome/Edge), Share → Add to Home Screen on iPhone.</sub></p>

---

A private spending dashboard for Capital One CSV exports (360 Checking, 360 Savings, credit card).
It runs entirely in the browser, installs as an app on a phone or computer, and works offline.

- **Your data stays on your device.** CSVs are read in the browser and saved in its local
  storage (IndexedDB). Nothing is uploaded anywhere unless you turn on sync.
- **Upload once, then just add.** New exports are merged in and transactions already saved are
  skipped, so overlapping date ranges are fine.
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
python tests/make_fixtures.py /tmp/fx
echo '{"merchant": {}, "amount_rules": []}' > /tmp/rules.json
python tests/run_python.py ../FinanceTracker /tmp/fx /tmp/rules.json /tmp/py.json
node tests/parity.mjs /tmp/fx /tmp/py.json /tmp/rules.json
node tests/sync.test.mjs
```

The one deliberate difference from the Python version is the auto-categorizer: scikit-learn's
logistic regression became a nearest-neighbour match over the same TF-IDF character n-grams
(`js/categorizer.js`), which needs no training step in the browser.

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

`vendor/chart.umd.min.js` is Chart.js 4.4.3 (MIT), vendored so the app works offline.
