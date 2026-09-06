package com.savrivo.firebase;

import android.content.Intent;
import android.os.CancellationSignal;
import android.util.Log;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;

import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes;
import com.google.android.gms.common.api.ApiException;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Shared Credential Manager implementation used by Savrivo's approved-role apps. */
public final class GoogleCredentialSignIn {
  private static final String TAG = "SavrivoGoogleAuth";

  public interface Callback {
    void onIdToken(String idToken);
    void onFailure(String message);
  }

  private final ComponentActivity activity;
  private final CredentialManager manager;
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final ActivityResultLauncher<Intent> legacySignInLauncher;
  private CancellationSignal cancellation;
  private Callback callback;
  private String serverClientId;
  private boolean inFlight;
  private boolean legacyFlowInFlight;

  public GoogleCredentialSignIn(ComponentActivity activity) {
    this.activity = activity;
    this.manager = CredentialManager.create(activity);
    this.legacySignInLauncher = activity.registerForActivityResult(
        new ActivityResultContracts.StartActivityForResult(),
        this::handleLegacySignInResult);
  }

  public void start(String serverClientId, Callback callback) {
    if (inFlight) return;
    if (serverClientId == null || serverClientId.trim().isEmpty()) {
      callback.onFailure("Google sign-in is not configured for this build.");
      return;
    }
    this.callback = callback;
    this.serverClientId = serverClientId.trim();
    inFlight = true;
    Log.i(TAG, "Starting Google sign-in via Credential Manager.");
    clearStateThenRequest(this.serverClientId);
  }

  private void clearStateThenRequest(String serverClientId) {
    manager.clearCredentialStateAsync(
        new ClearCredentialStateRequest(),
        new CancellationSignal(),
        executor,
        new CredentialManagerCallback<Void, ClearCredentialException>() {
          @Override public void onResult(Void ignored) {
            request(serverClientId);
          }

          @Override public void onError(ClearCredentialException error) {
            Log.w(TAG, "Credential state clear failed, continuing anyway: " + error.getClass().getSimpleName());
            request(serverClientId);
          }
        });
  }

  private void request(String serverClientId) {
    GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(serverClientId)
        .build();
    cancellation = new CancellationSignal();
    manager.getCredentialAsync(
        activity,
        new GetCredentialRequest.Builder().addCredentialOption(option).build(),
        cancellation,
        executor,
        new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
          @Override public void onResult(GetCredentialResponse response) {
            Credential credential = response == null ? null : response.getCredential();
            if (!(credential instanceof CustomCredential)
                || (!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())
                    && !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_SIWG_CREDENTIAL.equals(credential.getType()))) {
              Log.w(TAG, "Credential Manager returned unsupported credential type.");
              startLegacyFallback("unsupported_credential");
              return;
            }
            try {
              String token = GoogleIdTokenCredential.createFrom(credential.getData()).getIdToken();
              if (token == null || token.isEmpty()) {
                Log.w(TAG, "Credential Manager returned an empty ID token.");
                startLegacyFallback("empty_id_token");
                return;
              }
              activity.runOnUiThread(() -> {
                Log.i(TAG, "Credential Manager Google sign-in succeeded.");
                Callback current = callback;
                resetState();
                if (current != null) current.onIdToken(token);
              });
            } catch (RuntimeException error) {
              Log.w(TAG, "Credential Manager returned an invalid Google response.", error);
              startLegacyFallback("invalid_google_response");
            }
          }

          @Override public void onError(GetCredentialException error) {
            if (error instanceof GetCredentialCancellationException) {
              Log.i(TAG, "Credential Manager Google sign-in cancelled by user.");
              finishFailure("Google sign-in was cancelled.");
              return;
            }
            Log.w(TAG, "Credential Manager Google sign-in failed. Falling back to classic Google sign-in. "
                + error.getClass().getSimpleName() + ": " + error.getMessage());
            startLegacyFallback(error.getClass().getSimpleName());
          }
        });
  }

  private void startLegacyFallback(String reason) {
    activity.runOnUiThread(() -> {
      if (!inFlight || legacyFlowInFlight || callback == null || serverClientId == null || serverClientId.isEmpty()) {
        return;
      }
      legacyFlowInFlight = true;
      cancellation = null;
      Log.i(TAG, "Starting legacy Google sign-in fallback. Reason=" + reason);
      GoogleSignInOptions options = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
          .requestEmail()
          .requestIdToken(serverClientId)
          .build();
      GoogleSignInClient client = GoogleSignIn.getClient(activity, options);
      client.signOut().addOnCompleteListener(activity, task -> legacySignInLauncher.launch(client.getSignInIntent()));
    });
  }

  private void handleLegacySignInResult(ActivityResult result) {
    if (!inFlight || !legacyFlowInFlight || callback == null) return;
    try {
      GoogleSignInAccount account = GoogleSignIn.getSignedInAccountFromIntent(result.getData())
          .getResult(ApiException.class);
      String token = account == null ? null : account.getIdToken();
      if (token == null || token.isEmpty()) {
        Log.w(TAG, "Legacy Google sign-in returned an empty ID token.");
        finishFailure("Google did not return a sign-in token. Please try again.");
        return;
      }
      Log.i(TAG, "Legacy Google sign-in fallback succeeded.");
      Callback current = callback;
      resetState();
      if (current != null) current.onIdToken(token);
    } catch (ApiException error) {
      int code = error.getStatusCode();
      Log.w(TAG, "Legacy Google sign-in fallback failed with status=" + code, error);
      if (code == GoogleSignInStatusCodes.SIGN_IN_CANCELLED) {
        finishFailure("Google sign-in was cancelled.");
      } else {
        finishFailure("Google sign-in could not be completed. Check Google Play services and try again.");
      }
    } catch (RuntimeException error) {
      Log.w(TAG, "Legacy Google sign-in fallback returned an invalid response.", error);
      finishFailure("Google returned an invalid sign-in response. Please try again.");
    }
  }

  private void finishFailure(String message) {
    activity.runOnUiThread(() -> {
      Log.w(TAG, "Google sign-in failed: " + message);
      Callback current = callback;
      resetState();
      if (current != null) current.onFailure(message);
    });
  }

  private void resetState() {
    inFlight = false;
    legacyFlowInFlight = false;
    cancellation = null;
    callback = null;
    serverClientId = null;
  }

  public void close() {
    if (cancellation != null) cancellation.cancel();
    executor.shutdownNow();
  }
}
