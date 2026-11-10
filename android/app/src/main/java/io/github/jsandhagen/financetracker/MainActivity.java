package io.github.jsandhagen.financetracker;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlaidLinkPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(SaveFilePlugin.class);
        super.onCreate(savedInstanceState);

        // The web app keeps its own history (views, open sheets). Back steps
        // through that first and only puts the app away from the first screen.
        getOnBackPressedDispatcher()
            .addCallback(
                this,
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        WebView webView = getBridge() == null ? null : getBridge().getWebView();
                        if (webView != null && webView.canGoBack()) webView.goBack();
                        else moveTaskToBack(true);
                    }
                }
            );
    }
}
