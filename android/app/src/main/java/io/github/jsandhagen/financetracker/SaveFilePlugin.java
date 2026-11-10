package io.github.jsandhagen.financetracker;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saving a file the app made (a backup, a CSV export). A web page does this
 * with a download link, which an embedded web view ignores, so Android's own
 * "save to" screen is shown instead and the text is written where you choose.
 *
 * JS: Capacitor.nativePromise('SaveFile', 'save', { name, mime, text }) -> { saved }
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.isEmpty() || call.getString("text") == null) {
            call.reject("A file name and its text are required.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(call, intent, "saveResult");
        } catch (Exception e) {
            call.reject("No app on this device can save files: " + e.getMessage(), e);
        }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            ret.put("saved", false);
            call.resolve(ret);
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new java.io.IOException("the chosen location could not be opened");
            out.write(call.getString("text").getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            call.reject("Could not write the file: " + e.getMessage(), e);
            return;
        }
        ret.put("saved", true);
        call.resolve(ret);
    }
}
