package io.github.jsandhagen.financetracker;

import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.plaid.link.OpenPlaidLink;
import com.plaid.link.Plaid;
import com.plaid.link.PlaidLinkSession;
import com.plaid.link.configuration.LinkTokenConfiguration;
import com.plaid.link.result.LinkError;
import com.plaid.link.result.LinkExit;
import com.plaid.link.result.LinkInstitution;
import com.plaid.link.result.LinkResult;
import com.plaid.link.result.LinkSuccess;

/**
 * Plaid Link, the screen where you sign in to your bank, through Plaid's
 * Android SDK. Banks that sign you in on their own site or app (Capital One,
 * Bank of America) hand control back to the SDK by the app's package name,
 * which is why the web version of Link is not used here.
 *
 * JS: Capacitor.nativePromise('PlaidLink', 'open', { token })
 *   -> { publicToken, institution }            a bank was linked
 *   -> { exited: true, errorCode?, errorMessage? }   the screen was closed
 */
@CapacitorPlugin(name = "PlaidLink")
public class PlaidLinkPlugin extends Plugin {

    /** The id the link token must carry as android_package_name. */
    @PluginMethod
    public void packageName(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("packageName", getContext().getPackageName());
        call.resolve(ret);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String token = call.getString("token");
        if (token == null || token.isEmpty()) {
            call.reject("A link token is required.");
            return;
        }
        getActivity()
            .runOnUiThread(() -> {
                try {
                    LinkTokenConfiguration config = new LinkTokenConfiguration.Builder().token(token).build();
                    PlaidLinkSession session = Plaid.createPlaidLinkSession(getActivity().getApplication(), config);
                    Intent intent = new OpenPlaidLink().createIntent(getActivity(), session);
                    startActivityForResult(call, intent, "linkResult");
                } catch (Exception e) {
                    call.reject("Could not open Plaid: " + e.getMessage(), e);
                }
            });
    }

    @ActivityCallback
    private void linkResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        try {
            LinkResult parsed = new OpenPlaidLink().parseResult(result.getResultCode(), result.getData());
            if (parsed instanceof LinkSuccess) {
                LinkSuccess success = (LinkSuccess) parsed;
                LinkInstitution institution = success.getMetadata() == null ? null : success.getMetadata().getInstitution();
                ret.put("publicToken", success.getPublicToken());
                ret.put("institution", institution == null ? null : institution.getName());
            } else {
                ret.put("exited", true);
                LinkError error = parsed instanceof LinkExit ? ((LinkExit) parsed).getError() : null;
                if (error != null) {
                    ret.put("errorCode", error.getErrorCode() == null ? null : error.getErrorCode().getJson());
                    String shown = error.getDisplayMessage();
                    ret.put("errorMessage", shown == null || shown.isEmpty() ? error.getErrorMessage() : shown);
                }
            }
        } catch (Exception e) {
            call.reject("Plaid closed without an answer: " + e.getMessage(), e);
            return;
        }
        call.resolve(ret);
    }
}
