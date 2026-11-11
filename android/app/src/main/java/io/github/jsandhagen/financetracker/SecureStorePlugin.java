package io.github.jsandhagen.financetracker;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.Key;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small values (the Plaid keys) encrypted with a key that lives in the Android
 * Keystore. The key is generated on the device and cannot be exported; what is
 * written to the app's preferences is AES-256-GCM ciphertext, so a copy of the
 * app's files does not contain the secret.
 *
 * Nothing here ever throws a value away. If the Keystore cannot be read (it can
 * be slow or briefly unavailable right after a reboot), get() reports an error
 * and leaves the stored value as it is, to be read next time. The key is only
 * ever created by set(), and only when none exists: making a new one over an
 * existing key would leave what was stored unreadable for good.
 *
 * JS: Capacitor.nativePromise('SecureStore', 'set' | 'get' | 'remove', { key, value? })
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "financetracker.securestore.v1";
    private static final String PREFS = "financetracker.securestore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The Keystore key; with create false, an error when there is none. */
    private Key key(boolean create) throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;
        if (!create || keyStore.containsAlias(KEY_ALIAS)) throw new java.security.KeyStoreException("the Keystore key could not be read");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("key");
        String value = call.getString("value");
        if (name == null || name.isEmpty() || value == null) {
            call.reject("A key and a value are required.");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key(true)); // the Keystore picks a fresh IV
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String stored = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
            if (!prefs().edit().putString(name, stored).commit()) {
                call.reject("Could not write to the device's storage.");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not encrypt with the Android Keystore: " + e.getMessage(), e);
        }
    }

    /**
     * Resolves { value }, null when nothing is stored. Rejects with code
     * UNREADABLE when something is stored but cannot be decrypted right now;
     * it is kept.
     */
    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("key");
        if (name == null || name.isEmpty()) {
            call.reject("A key is required.");
            return;
        }
        JSObject ret = new JSObject();
        String stored = prefs().getString(name, null);
        String value = null;
        if (stored != null) {
            try {
                String[] parts = stored.split(":", 2);
                Cipher cipher = Cipher.getInstance(TRANSFORMATION);
                cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
                value = new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
            } catch (Exception e) {
                call.reject("Your saved Plaid keys could not be read just now. They are still saved.", "UNREADABLE", e);
                return;
            }
        }
        ret.put("value", value == null ? JSObject.NULL : value);
        call.resolve(ret);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = call.getString("key");
        if (name == null || name.isEmpty()) {
            call.reject("A key is required.");
            return;
        }
        prefs().edit().remove(name).commit();
        call.resolve();
    }
}
