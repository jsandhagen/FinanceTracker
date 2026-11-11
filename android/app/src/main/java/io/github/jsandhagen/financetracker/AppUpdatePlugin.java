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
                // Android would refuse it anyway; saying so here keeps anyone from
                // "fixing" that by uninstalling, which would delete the data.
                if (!sameSigner(apk)) {
                    apk.delete();
                    call.reject("This update is not signed with the same key as the app you have, so it was not installed. Do not uninstall the app to get it: your data would go with it.", "WRONG_SIGNER");
                    return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().runOnUiThread(() -> {
                    try {
                        getContext().startActivity(intent);
                        call.resolve();
                    } catch (Exception e) {
                        call.reject("Could not open the installer: " + e.getMessage(), e);
                    }
                });
            } catch (Exception e) {
                call.reject("Could not download the update: " + e.getMessage(), e);
            }
        }).start();
    }

    @SuppressWarnings("deprecation")
    private boolean sameSigner(File apk) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo mine = pm.getPackageInfo(getContext().getPackageName(), flags);
        PackageInfo theirs = pm.getPackageArchiveInfo(apk.getPath(), flags);
        if (theirs == null || !getContext().getPackageName().equals(theirs.packageName)) return false;
        java.util.Set<String> a = signers(mine), b = signers(theirs);
        return !a.isEmpty() && a.equals(b);
    }

    @SuppressWarnings("deprecation")
    private static java.util.Set<String> signers(PackageInfo p) {
        Signature[] sigs;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            sigs = p.signingInfo == null ? null
                : p.signingInfo.hasMultipleSigners() ? p.signingInfo.getApkContentsSigners() : p.signingInfo.getSigningCertificateHistory();
        } else {
            sigs = p.signatures;
        }
        java.util.Set<String> out = new java.util.HashSet<>();
        if (sigs != null) for (Signature s : sigs) out.add(s.toCharsString());
        return out;
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
