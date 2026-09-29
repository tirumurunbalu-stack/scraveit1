package com.feastly.rider;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.ComponentActivity;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ExperimentalGetImage;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.List;

/**
 * A forced-front-camera, capture-only screen: no gallery picker, no camera
 * switch, and now no manual shutter either - the photo is taken
 * automatically the instant an on-device blink is detected. That's the
 * cheap-but-real liveness check: a printed photo or a photo of a phone
 * screen held up to the camera can't blink on command, so it just sits
 * there waiting and never triggers a capture. It doesn't stop a determined
 * video-replay attack, but it closes the attack that actually matters here
 * (an old photo, someone else's photo).
 */
public final class FaceCaptureActivity extends ComponentActivity {
    public static final String EXTRA_IMAGE_PATH = "imagePath";
    private static final int MAX_OUTPUT_DIMENSION = 900;
    private static final float EYES_CLOSED_THRESHOLD = 0.35f;
    private static final float EYES_OPEN_THRESHOLD = 0.6f;

    private static final int BLINK_STATE_WAIT_FACE = 0;
    private static final int BLINK_STATE_EYES_OPEN = 1;
    private static final int BLINK_STATE_EYES_CLOSED = 2;
    private static final int BLINK_STATE_CONFIRMED = 3;

    // Luminance is 0-255, sampled from the analysis frame's own Y plane - no
    // separate light sensor needed. Two thresholds (not one) give hysteresis
    // so a reading hovering near the boundary doesn't flicker the screen
    // flash on and off; a short run of consecutive frames on either side
    // (not a single frame) is required before actually switching, since one
    // noisy frame shouldn't be enough either.
    private static final int LOW_LIGHT_ON_THRESHOLD = 60;
    private static final int LOW_LIGHT_OFF_THRESHOLD = 90;
    private static final int LOW_LIGHT_STREAK_FRAMES = 6;
    private static final int LUMINANCE_SAMPLE_STEP = 8;

    private PreviewView previewView;
    private FrameLayout reviewOverlay;
    private ImageView reviewImage;
    private TextView promptLabel;
    private ImageCapture imageCapture;
    private FaceDetector faceDetector;
    private File pendingFile;
    private int blinkState = BLINK_STATE_WAIT_FACE;
    private boolean captureInFlight;

    private Camera camera;
    private View faceGuideOverlay;
    private boolean lowLight;
    private int lowLightOnStreak;
    private int lowLightOffStreak;
    private float defaultScreenBrightness = -1f;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { cancel(); }
        });
        FaceDetectorOptions options = new FaceDetectorOptions.Builder()
                .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                .build();
        faceDetector = FaceDetection.getClient(options);
        setContentView(buildLayout());
        startCamera();
    }

    private View buildLayout() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        root.addView(previewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(buildFaceGuideOverlay(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        promptLabel = new TextView(this);
        promptLabel.setTextColor(Color.WHITE);
        promptLabel.setTextSize(16f);
        promptLabel.setGravity(Gravity.CENTER);
        promptLabel.setPadding(dp(24), dp(20), dp(24), dp(20));
        updatePrompt();
        FrameLayout.LayoutParams promptParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        promptParams.gravity = Gravity.TOP;
        root.addView(promptLabel, promptParams);

        TextView closeButton = new TextView(this);
        closeButton.setText("Cancel");
        closeButton.setTextColor(Color.WHITE);
        closeButton.setTextSize(15f);
        closeButton.setPadding(dp(18), dp(14), dp(18), dp(14));
        closeButton.setOnClickListener(v -> cancel());
        FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        closeParams.gravity = Gravity.TOP | Gravity.END;
        root.addView(closeButton, closeParams);

        root.addView(buildReviewOverlay(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return root;
    }

    /**
     * A dimmed layer with a circular cutout, so the person can line their
     * face up before capturing. In low light this doubles as the "flash":
     * a front camera almost never has a physical LED flash, so the area
     * outside the circle turns bright white instead of dim, and the phone's
     * own screen becomes the fill light - the same trick selfie cameras use.
     * The circle itself is left alone so the live preview stays visible.
     */
    private View buildFaceGuideOverlay() {
        faceGuideOverlay = new View(this) {
            @Override protected void onDraw(Canvas canvas) {
                super.onDraw(canvas);
                Bitmap mask = Bitmap.createBitmap(getWidth(), getHeight(), Bitmap.Config.ARGB_8888);
                Canvas maskCanvas = new Canvas(mask);
                Paint dim = new Paint(Paint.ANTI_ALIAS_FLAG);
                dim.setColor(lowLight ? Color.WHITE : Color.argb(150, 0, 0, 0));
                maskCanvas.drawRect(0, 0, getWidth(), getHeight(), dim);
                float radius = Math.min(getWidth(), getHeight()) * 0.36f;
                float cx = getWidth() / 2f, cy = getHeight() * 0.42f;
                Paint hole = new Paint(Paint.ANTI_ALIAS_FLAG);
                hole.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
                maskCanvas.drawCircle(cx, cy, radius, hole);
                canvas.drawBitmap(mask, 0, 0, null);
                Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
                ring.setStyle(Paint.Style.STROKE);
                ring.setStrokeWidth(dp(3));
                ring.setColor(Color.WHITE);
                canvas.drawCircle(cx, cy, radius, ring);
            }
        };
        return faceGuideOverlay;
    }

    private FrameLayout buildReviewOverlay() {
        reviewOverlay = new FrameLayout(this);
        reviewOverlay.setBackgroundColor(Color.BLACK);
        reviewOverlay.setVisibility(View.GONE);

        reviewImage = new ImageView(this);
        reviewImage.setScaleType(ImageView.ScaleType.CENTER_CROP);
        reviewOverlay.addView(reviewImage, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        actions.setPadding(dp(24), dp(20), dp(24), dp(20));
        actions.setBackgroundColor(Color.argb(190, 0, 0, 0));

        TextView retake = new TextView(this);
        retake.setText("Retake");
        retake.setTextColor(Color.WHITE);
        retake.setTextSize(16f);
        retake.setPadding(dp(28), dp(14), dp(28), dp(14));
        retake.setOnClickListener(v -> retake());

        TextView use = new TextView(this);
        use.setText("Use this photo");
        use.setTextColor(Color.BLACK);
        use.setTextSize(16f);
        use.setBackgroundColor(Color.WHITE);
        use.setPadding(dp(28), dp(14), dp(28), dp(14));
        use.setOnClickListener(v -> confirm());

        LinearLayout.LayoutParams spacer = new LinearLayout.LayoutParams(dp(24), dp(1));
        actions.addView(retake);
        actions.addView(new View(this), spacer);
        actions.addView(use);

        FrameLayout.LayoutParams actionParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        actionParams.gravity = Gravity.BOTTOM;
        reviewOverlay.addView(actions, actionParams);
        return reviewOverlay;
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                ProcessCameraProvider provider = future.get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                imageCapture = new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .build();
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build();
                analysis.setAnalyzer(ContextCompat.getMainExecutor(this), this::analyzeFrame);
                provider.unbindAll();
                camera = provider.bindToLifecycle(
                        this, CameraSelector.DEFAULT_FRONT_CAMERA, preview, imageCapture, analysis);
            } catch (Exception error) {
                cancel();
            }
        }, ContextCompat.getMainExecutor(this));
    }

    @OptIn(markerClass = ExperimentalGetImage.class)
    private void analyzeFrame(ImageProxy imageProxy) {
        if (captureInFlight || imageProxy.getImage() == null) {
            imageProxy.close();
            return;
        }
        updateLowLightState(estimateLuminance(imageProxy));
        InputImage input = InputImage.fromMediaImage(
                imageProxy.getImage(), imageProxy.getImageInfo().getRotationDegrees());
        faceDetector.process(input)
                .addOnSuccessListener(this::handleFaces)
                .addOnFailureListener(error -> { })
                .addOnCompleteListener(task -> imageProxy.close());
    }

    /**
     * A cheap 0-255 brightness estimate straight from the analysis frame's
     * own luma (Y) plane - no extra sensor or capture needed. Sampled on a
     * coarse grid (every LUMINANCE_SAMPLE_STEP pixels) since an exact
     * per-pixel average buys nothing here and would just cost more per frame.
     */
    private int estimateLuminance(ImageProxy imageProxy) {
        ImageProxy.PlaneProxy plane = imageProxy.getPlanes()[0];
        java.nio.ByteBuffer buffer = plane.getBuffer();
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();
        int width = imageProxy.getWidth();
        int height = imageProxy.getHeight();
        long sum = 0;
        int count = 0;
        for (int y = 0; y < height; y += LUMINANCE_SAMPLE_STEP) {
            int rowStart = y * rowStride;
            for (int x = 0; x < width; x += LUMINANCE_SAMPLE_STEP) {
                int index = rowStart + x * pixelStride;
                if (index < 0 || index >= buffer.capacity()) continue;
                sum += buffer.get(index) & 0xFF;
                count++;
            }
        }
        return count == 0 ? 128 : (int) (sum / count);
    }

    private void updateLowLightState(int luminance) {
        if (luminance < LOW_LIGHT_ON_THRESHOLD) {
            lowLightOnStreak++;
            lowLightOffStreak = 0;
        } else if (luminance > LOW_LIGHT_OFF_THRESHOLD) {
            lowLightOffStreak++;
            lowLightOnStreak = 0;
        } else {
            lowLightOnStreak = 0;
            lowLightOffStreak = 0;
        }
        // Once on, the flash stays on for the rest of this capture: its own
        // light brightens the face, so switching off on a bright reading
        // turned it off mid-blink and the photo came out dark. The window
        // brightness and the torch both reset when this screen closes.
        if (!lowLight && lowLightOnStreak >= LOW_LIGHT_STREAK_FRAMES) {
            setLowLight(true);
        }
    }

    private void setLowLight(boolean active) {
        if (lowLight == active) return;
        lowLight = active;
        lowLightOnStreak = 0;
        lowLightOffStreak = 0;
        if (faceGuideOverlay != null) faceGuideOverlay.invalidate();
        applyScreenBrightness(active);
        // A physical torch is rare on a front camera, but a handful of
        // phones do have one - use it in addition to the screen flash when
        // it's there rather than assuming one or the other.
        if (camera != null && camera.getCameraInfo().hasFlashUnit()) {
            try { camera.getCameraControl().enableTorch(active); } catch (Exception ignored) { }
        }
    }

    private void applyScreenBrightness(boolean bright) {
        android.view.WindowManager.LayoutParams params = getWindow().getAttributes();
        if (bright) {
            if (defaultScreenBrightness < 0f) defaultScreenBrightness = params.screenBrightness;
            params.screenBrightness = 1f;
        } else if (defaultScreenBrightness >= 0f) {
            params.screenBrightness = defaultScreenBrightness;
        }
        getWindow().setAttributes(params);
    }

    /**
     * A blink is "eyes were open, then closed, then open again" - not a
     * single low-probability frame, which a bad-lighting flicker could
     * produce on its own. Confirming the state machine returns to open
     * before triggering capture also means the photo actually submitted has
     * the person's eyes open, which is what a good face-match photo needs.
     */
    private void handleFaces(List<Face> faces) {
        if (captureInFlight) return;
        if (faces.isEmpty()) {
            if (blinkState != BLINK_STATE_WAIT_FACE) { blinkState = BLINK_STATE_WAIT_FACE; updatePrompt(); }
            return;
        }
        Face face = faces.get(0);
        Float leftOpen = face.getLeftEyeOpenProbability();
        Float rightOpen = face.getRightEyeOpenProbability();
        if (leftOpen == null || rightOpen == null) return;
        float openness = (leftOpen + rightOpen) / 2f;
        if (blinkState == BLINK_STATE_WAIT_FACE) {
            blinkState = BLINK_STATE_EYES_OPEN;
            updatePrompt();
        } else if (blinkState == BLINK_STATE_EYES_OPEN && openness < EYES_CLOSED_THRESHOLD) {
            blinkState = BLINK_STATE_EYES_CLOSED;
            updatePrompt();
        } else if (blinkState == BLINK_STATE_EYES_CLOSED && openness > EYES_OPEN_THRESHOLD) {
            blinkState = BLINK_STATE_CONFIRMED;
            updatePrompt();
            captureInFlight = true;
            capture();
        }
    }

    private void updatePrompt() {
        switch (blinkState) {
            case BLINK_STATE_WAIT_FACE:
                promptLabel.setText("Centre your face in the circle");
                break;
            case BLINK_STATE_EYES_OPEN:
                promptLabel.setText("Now blink naturally - it captures on its own");
                break;
            case BLINK_STATE_EYES_CLOSED:
                promptLabel.setText("Good - open your eyes again");
                break;
            case BLINK_STATE_CONFIRMED:
                promptLabel.setText("Got it, hold still…");
                break;
            default:
                break;
        }
    }

    private void capture() {
        if (imageCapture == null) { captureInFlight = false; return; }
        imageCapture.takePicture(ContextCompat.getMainExecutor(this), new ImageCapture.OnImageCapturedCallback() {
            @Override public void onCaptureSuccess(@NonNull ImageProxy image) {
                Bitmap bitmap = toBitmap(image);
                image.close();
                if (bitmap == null) { resetBlinkState(); return; }
                showReview(bitmap);
            }
            @Override public void onError(@NonNull ImageCaptureException exception) {
                resetBlinkState();
            }
        });
    }

    private void resetBlinkState() {
        captureInFlight = false;
        blinkState = BLINK_STATE_WAIT_FACE;
        updatePrompt();
    }

    private Bitmap toBitmap(ImageProxy image) {
        try {
            ImageProxy.PlaneProxy plane = image.getPlanes()[0];
            byte[] bytes = new byte[plane.getBuffer().remaining()];
            plane.getBuffer().get(bytes);
            Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (decoded == null) return null;
            int rotation = image.getImageInfo().getRotationDegrees();
            // The front camera's sensor image is mirrored relative to what the
            // person saw in the live preview - flip it back so the reference
            // photo looks like a normal selfie, not a mirror image.
            Matrix matrix = new Matrix();
            if (rotation != 0) matrix.postRotate(rotation);
            matrix.postScale(-1f, 1f);
            Bitmap oriented = Bitmap.createBitmap(decoded, 0, 0, decoded.getWidth(), decoded.getHeight(), matrix, true);
            if (oriented != decoded) decoded.recycle();
            return downscale(oriented);
        } catch (Exception error) {
            return null;
        }
    }

    private Bitmap downscale(Bitmap source) {
        int width = source.getWidth(), height = source.getHeight();
        float scale = Math.min(1f, ((float) MAX_OUTPUT_DIMENSION) / Math.max(width, height));
        if (scale >= 1f) return source;
        Bitmap scaled = Bitmap.createScaledBitmap(source, Math.round(width * scale), Math.round(height * scale), true);
        if (scaled != source) source.recycle();
        return scaled;
    }

    private void showReview(Bitmap bitmap) {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out);
            File file = new File(getCacheDir(), "face_" + System.currentTimeMillis() + ".jpg");
            try (FileOutputStream stream = new FileOutputStream(file)) {
                stream.write(out.toByteArray());
            }
            pendingFile = file;
        } catch (Exception error) {
            resetBlinkState();
            return;
        }
        reviewImage.setImageBitmap(bitmap);
        reviewOverlay.setVisibility(View.VISIBLE);
    }

    private void retake() {
        reviewOverlay.setVisibility(View.GONE);
        if (pendingFile != null) { try { pendingFile.delete(); } catch (Exception ignored) { } pendingFile = null; }
        resetBlinkState();
    }

    private void confirm() {
        if (pendingFile == null) return;
        android.content.Intent result = new android.content.Intent();
        result.putExtra(EXTRA_IMAGE_PATH, pendingFile.getAbsolutePath());
        setResult(RESULT_OK, result);
        finish();
    }

    private void cancel() {
        if (pendingFile != null) { try { pendingFile.delete(); } catch (Exception ignored) { } pendingFile = null; }
        setResult(RESULT_CANCELED);
        finish();
    }

    @Override protected void onDestroy() {
        if (faceDetector != null) { try { faceDetector.close(); } catch (Exception ignored) { } }
        super.onDestroy();
    }

    private int dp(int value) {
        DisplayMetrics metrics = getResources().getDisplayMetrics();
        return Math.round(value * metrics.density);
    }
}
