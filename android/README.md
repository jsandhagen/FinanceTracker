# FinanceTracker for Android

The same app as the website, inside a native wrapper ([Capacitor](https://capacitorjs.com)). It
exists for one reason: **a native app can call Plaid by itself**, so a bank connection needs no
relay and nothing hosted.

A web page cannot do that. A browser only lets a page read another site's answer if that site
allows it, and Plaid's API is built for servers. Inside the wrapper the same requests are made by
Android, where that rule does not apply.

> **Status: builds, not yet run on a phone.** The code is covered by the tests in `tests/` and the
> APK is compiled by GitHub Actions, but until it has been installed and a bank has been linked on
> a real device, treat everything below as untested. Start with Plaid's Sandbox (step 4).

What is different from the website:

| | Website | Android app |
| --- | --- | --- |
| Calls to Plaid | refused by the browser, so a relay is needed | made by Android (`CapacitorHttp`), direct |
| Plaid Link (bank sign-in) | Plaid's web script and a redirect address | Plaid's Android SDK and the app's package name |
| Plaid client_id and secret | IndexedDB | encrypted with a key in the Android Keystore |
| Updates | by itself, on every deploy | the app offers each new build; **Update**, then Android's **Install** |
| Saving a backup or export | a download | Android's "save to" screen |

Everything else is one codebase: `index.html`, `css/`, `js/`. The only file that knows about the
wrapper is `js/native.js`, and the native side is three small classes in
`app/src/main/java/io/github/jsandhagen/financetracker/`.

The website keeps working as it is. Turn on **Settings → Sync between devices** on the phone and
in the browser, and what the phone fetches from the bank shows up on the website too.

## Setting it up

### 1. A key of your own (once, before the first install)

Android installs an update only over an app signed with the same key. Without a key of your own,
each build is signed with a throwaway one, the next build will not install over it, and removing
an app to make room removes its data and its saved Plaid keys. So do this first.

On any computer with Java installed:

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore financetracker.keystore \
  -alias financetracker -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=FinanceTracker"
base64 -w0 financetracker.keystore   # macOS: base64 -i financetracker.keystore
```

Keep `financetracker.keystore` and its password somewhere safe (a password manager takes file
attachments). If it is lost, the next build has to be a fresh install. Then on GitHub, in
**Settings → Secrets and variables → Actions**, add:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the output of the `base64` command |
| `ANDROID_KEYSTORE_PASSWORD` | the password you chose |

(`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` are only needed if you used another alias or a
separate key password.)

### 2. Build the APK

The **Android** workflow builds on every push that touches the app, and on demand from
**Actions → Android → Run workflow**.

- From `main`, with the secrets in place, the APK is published at
  `https://github.com/<you>/FinanceTracker/releases/download/android-latest/FinanceTracker.apk`.
- Every run also keeps it under **Artifacts** on the run's page (a zip holding the APK; you have
  to be signed in to GitHub to download it).

The run's summary says which key signed the build.

### 3. Install it (sideloading)

Open the address above in Chrome on the phone, or copy the APK over, and tap it. Android asks once
to allow installs from that app (Chrome, or your file manager): allow it, then **Install**. Play
Protect may offer to scan an app it has not seen before; that is fine.

After that the app updates itself, with your go-ahead:

- When it opens (and every few hours while in use) it looks at the `android-latest` release. A
  newer build shows **A new version of the app is ready · Update**; it is also under
  **Settings → App version**, where **Check for updates** looks straight away.
- **Update** downloads it and Android's own installer asks you to confirm. The very first time,
  Android first asks you to let FinanceTracker install apps ("Allow from this source"); come back
  and tap **Update** again.
- Android installs it only if it is signed with the same key as the app you have, so a download
  that was tampered with cannot replace it. Your data and Plaid keys stay.

Android does not let a sideloaded app replace itself without that one tap. For updates with no
tap at all, install the app through [Obtainium](https://github.com/ImranR98/Obtainium) instead,
pointed at this repository's releases: on Android 12 and later it updates apps it installed in
the background.

Each build from `main` is published with a `version.json` beside the APK; that is what the app
reads. A build from before the update button existed has to be replaced by hand once.

### 4. Plaid

1. In the [Plaid dashboard](https://dashboard.plaid.com), under **Developers → API**, add
   `io.github.jsandhagen.financetracker` to **Allowed Android package names**. Banks that sign you
   in on their own site or app (Capital One and Bank of America both do) use it to hand you back.
   No redirect URI is needed for the Android app.
2. In the app: **Accounts → Bank connection**. Enter the **client_id** and the **secret** for the
   environment you chose, and press **Save**. Save makes one harmless request to check the keys.
3. **Try Sandbox first.** Choose *Sandbox*, use the Sandbox secret, connect Plaid's test bank
   (`user_good` / `pass_good`), and check that transactions arrive. Then **Forget the Plaid keys on
   this device**, remove the test bank, and enter the Production secret.
4. **Connect a bank**, once for Capital One and once for Bank of America.

#### Before relying on Plaid's free plan

Plaid's Trial plan is reported to give production access to Capital One and Bank of America at no
cost, with these limits. **Check them in your own dashboard**; they are Plaid's to change and have
not been verified here:

- It is offered to teams created on or after 15 April 2026. An older team may need another route
  to production access.
- It allows **10 Items in total**, an Item being one bank connection. **Removing a connection does
  not give the slot back.**

So do not spend them testing. Do the trial runs in Sandbox, which is unlimited. In production,
connect each bank once and leave it; if a bank asks you to sign in again, use **Sign in** on the
connection (that repairs the same Item) rather than removing it and connecting again. Capital One
and Bank of America also have to approve an app for their own sign-in; the dashboard shows that
status per institution.

## What is stored where, and how it survives

- **Plaid client_id and secret:** encrypted with AES-256-GCM under a key generated inside the
  Android Keystore, which cannot be taken off the device. Only the ciphertext is written to the
  app's storage. They are sent to Plaid only, and are never in a backup file. With sync on, they
  are also in the sync copy, encrypted with your passphrase, so that a reinstall can get them
  back.
- **Each bank's access token:** with the rest of your data (see below), and in the encrypted sync
  copy so another device can fetch too. Without the secret it opens nothing.
- **Transactions, rules, settings:** the app's own storage on the phone (IndexedDB), as on the
  website. Android's cloud backup and device-to-device transfer are switched off for this app, so
  nothing reaches Google; use the app's sync or **Download backup** to move data.

### Updates never lose data

An update keeps everything, the Plaid keys included, and this is guarded at each step:

- **Only an update that can install over the app is published.** The build workflow refuses to
  publish a build that is not signed with the app's key (its certificate fingerprint is checked)
  or not numbered above the last one. Version numbers are minutes since 2026, so they only grow.
- **The app checks the download too, but Android decides.** If the app cannot match the update's
  key to its own it still hands it to Android's installer, which is the real check, and warns you
  not to uninstall if the installer refuses. (The app used to refuse such a download itself; on a
  real phone it refused a correctly signed one, which blocked every later update. A build from
  before that was fixed has to be updated by hand once: open the APK's address from step 2 in
  Chrome on the phone and install it over the app. Do not uninstall first.)
- **Where the data lives is pinned.** The app's storage belongs to its package id and its internal
  address (`https://localhost`); both are fixed in `capacitor.config.json`, and a test fails if
  either changes.
- **The keys are never thrown away.** If the Keystore cannot be read for a moment (it can be slow
  right after a restart), the app says so and keeps them; it never treats that as "no keys".
- **One more copy first.** With sync on, the app syncs before handing an update to the installer.

What updates cannot protect against is removing the app. Two things soften that: on Android 10
and later, uninstalling asks whether to **keep the app's data**, which keeps your transactions;
and with **sync** on, everything, Plaid keys included, comes back after a reinstall when you enter
the same token and passphrase. (The Keystore itself is always wiped with the app, which is why the
keys travel in the encrypted sync copy.) Turn sync on.

## Samsung DeX

On a monitor the app opens as a desktop-sized window (1280 × 800) with the full dashboard. Moving
it between the phone and DeX restarts its screen at the new scale (your data is kept; it reopens
on the Overview), which is what keeps it from showing the phone's zoomed-in layout. Resize the window
and the layout follows: from about 860 to 1100 wide the menu folds to icons (`[` opens it), below
that it is the phone layout. With a mouse, right-click a transaction to recategorize it; with a
keyboard, `Ctrl K` searches, `1`–`7` switch views and `Ctrl F` finds in the ledger. No touch
screen is needed.

## Known gaps

- **Share → FinanceTracker** (handing over a CSV from Chrome's downloads) is a feature of the
  installed website and is not wired into this app. Use the file chooser under **Refresh data**.
- Updates need one tap on Android's install screen (or Obtainium, above).
- A relay cannot be used from the Android app. It does not need one.

## Building it yourself

Needs Node 22, JDK 21 and the Android SDK (Android Studio brings both of the last two).

```bash
npm ci
npm run android:sync          # gathers the web app into www/ and copies it into android/
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run android:sync` has to be run again after any change to the web files. To sign a release
locally, set `ANDROID_KEYSTORE_FILE` and `ANDROID_KEYSTORE_PASSWORD` and run
`./gradlew assembleRelease`.

`www/`, `node_modules/` and the copied web files under `android/app/src/main/assets/` are
generated and not committed.
