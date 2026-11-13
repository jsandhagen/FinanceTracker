package io.github.jsandhagen.financetracker;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updating the app from inside it. The app has no store behind it, so a newer
 * build is downloaded from the GitHub release and handed to Android's own
 * installer, which asks you to confirm. Android installs it only if it is
 * signed with the same key as the app already installed, so a download that
 * was tampered with cannot replace it, and your data is kept.
 *
 * The installer is the one judge of that. The app compares the signatures too,
 * but only to warn: its own reading of a downloaded file has been wrong on a
 * real phone (it refused a correctly signed update, and with it every update
 * after), so a mismatch here never stops the download reaching the installer.
 *
 * JS: Capacitor.nativePromise('AppUpdate', 'info' | 'allowInstalls' | 'install', { url })
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private static final String RELEASES = "https://github.com/jsandhagen/FinanceTracker/releases/download/";

    /** { versionCode, versionName, canInstall } for the app as installed. */
    @PluginMethod
    public void info(PluginCall call) {
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject ret = new JSObject();
            ret.put("versionCode", PackageInfoCompat.getLongVersionCode(p));
            ret.put("versionName", p.versionName);
            ret.put("canInstall", canInstall());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not read the app's version: " + e.getMessage(), e);
        }
    }

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls();
    }

    /** Opens the setting that lets this app install updates (asked once). */
    @PluginMethod
    public void allowInstalls(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open the setting: " + e.getMessage(), e);
        }
    }

    /** Downloads the APK at `url` (this repository's releases only) and opens the installer. */
    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith(RELEASES)) {
            call.reject("Updates are only taken from this app's own releases.");
            return;
        }
        if (!canInstall()) {
            call.reject("Allow FinanceTracker to install updates first.", "NOT_ALLOWED");
            return;
        }
        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("no room for the download");
                File apk = new File(dir, "FinanceTracker.apk");
                download(url, apk);
                PackageInfo theirs = getContext().getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
                if (theirs != null && !getContext().getPackageName().equals(theirs.packageName)) {
                    apk.delete();
                    call.reject("That download is not FinanceTracker, so it was not installed.", "WRONG_APP");
                    return;
                }
                // true: the same key. false or null: it differs, or could not be
                // read. Either way Android's installer decides; the app is told,
                // so it can say not to uninstall if the installer refuses.
                Boolean same = sameSigner(apk);
                if (!Boolean.TRUE.equals(same)) android.util.Log.w("AppUpdate", "signature check: " + (same == null ? "could not be read" : "differs") + "; left to the installer");
                JSObject out = new JSObject();
                out.put("verified", Boolean.TRUE.equals(same));
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().runOnUiThread(() -> {
                    try {
                        getContext().startActivity(intent);
                        call.resolve(out);
                    } catch (Exception e) {
                        call.reject("Could not open the installer: " + e.getMessage(), e);
                    }
                });
            } catch (Exception e) {
                call.reject("Could not download the update: " + e.getMessage(), e);
            }
        }).start();
    }

    /**
     * Whether the downloaded APK carries a certificate the installed app is
     * signed with: true, false, or null when either could not be read. Both are
     * read every way Android offers, since which of them answers for a file on
     * disk differs between versions.
     */
    @SuppressWarnings("deprecation")
    private Boolean sameSigner(File apk) {
        try {
            PackageManager pm = getContext().getPackageManager();
            java.util.Set<String> mine = new java.util.HashSet<>(), theirs = new java.util.HashSet<>();
            java.util.List<Integer> ways = new java.util.ArrayList<>();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) ways.add(PackageManager.GET_SIGNING_CERTIFICATES);
            ways.add(PackageManager.GET_SIGNATURES);
            for (int flags : ways) {
                try { addSigners(mine, pm.getPackageInfo(getContext().getPackageName(), flags)); } catch (Exception ignored) { }
                try { addSigners(theirs, pm.getPackageArchiveInfo(apk.getPath(), flags)); } catch (Exception ignored) { }
            }
            if (mine.isEmpty() || theirs.isEmpty()) return null;
            for (String s : theirs) if (mine.contains(s)) return true;
            return false;
        } catch (Exception e) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private static void addSigners(java.util.Set<String> out, PackageInfo p) {
        if (p == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && p.signingInfo != null) {
            add(out, p.signingInfo.getApkContentsSigners());
            add(out, p.signingInfo.getSigningCertificateHistory());
        }
        add(out, p.signatures);
    }

    private static void add(java.util.Set<String> out, Signature[] sigs) {
        if (sigs != null) for (Signature s : sigs) if (s != null) out.add(s.toCharsString());
    }

    private static void download(String from, File to) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(from).openConnection();
        c.setInstanceFollowRedirects(true); // GitHub hands the file over from another address
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        try {
            if (c.getResponseCode() != 200) throw new java.io.IOException("the server answered " + c.getResponseCode());
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
        } finally {
            c.disconnect();
        }
    }
}
