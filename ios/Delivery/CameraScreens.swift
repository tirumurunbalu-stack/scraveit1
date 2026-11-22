import UIKit
import AVFoundation
import CoreImage
import Vision

/// Asks for the camera once, then runs `ready` on the main thread with the answer.
enum CameraAccess {
    static func request(_ ready: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: ready(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in DispatchQueue.main.async { ready(granted) } }
        default: ready(false)
        }
    }
}

// MARK: - Face check photo

/// The iPhone version of Android's FaceCaptureActivity: front camera, a circle
/// guide, and the photo is taken by itself after a natural blink (closed, then
/// open), so a printed photo can't pass. Then Retake / Use this photo.
/// Result: JPEG, the full 720 x 1280 frame, under 1.4 MB (the server needs 600+ px wide).
final class FaceCaptureViewController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let finish: (Result<Data, FaceCaptureError>) -> Void
    private let session = AVCaptureSession()
    private let frames = DispatchQueue(label: "in.scraveit.delivery.face")
    /// How open the eyes are (eye height / width) on recent frames while waiting for a
    /// blink. A blink is measured against this person's own usual open eyes (the median
    /// of recent frames, so the frame-to-frame jitter of the eye outline doesn't raise the
    /// bar), so narrow eyes still work. Vision's eye outline rarely closes fully on a
    /// quick blink, so a drop below 72% counts as closed; a photo never changes at all.
    private var openSamples: [CGFloat] = []  // frames queue only
    private var openBaseline: CGFloat = 0     // frames queue only
    private var closedSince = 0               // frames queue only: frame number the eyes closed at
    private var missedFaces = 0               // frames queue only: frames in a row without one face
    private static let closedRatio: CGFloat = 0.72  // below 72% of usual open = closed
    private static let openRatio: CGFloat = 0.85    // back above 85% of usual open = open again
    private let context = CIContext()
    private let prompt = UILabel()
    private let preview = UIImageView()
    private let ring = CAShapeLayer()
    /// Dim layer with the circle cut out. In low light it turns white and the
    /// screen goes to full brightness: the front camera has no flash, so the
    /// phone's own screen lights the face (same as Android's FaceCaptureActivity).
    private let shade = CAShapeLayer()
    private let cancel = UIButton(type: .system)
    private var screenLight = false        // main thread
    private var savedBrightness: CGFloat?  // main thread
    private var darkStreak = 0             // frames queue only
    private var lightRequested = false     // frames queue only
    private static let darkLuma = 70       // 0-255 average; Android uses 60 on its own camera
    private static let darkFrames = 6      // checked frames in a row before the light comes on
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var actions = UIStackView()
    private var frameCount = 0
    private var sawClosedEyes = false   // frames queue only
    private var frozen = false          // frames queue only: a photo is waiting for Retake / Use
    private var captured: Data?
    private var done = false

    enum FaceCaptureError: Error { case cancelled, cameraDenied, cameraUnavailable }

    init(finish: @escaping (Result<Data, FaceCaptureError>) -> Void) {
        self.finish = finish
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { screenLight ? .darkContent : .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        ring.fillColor = UIColor.clear.cgColor
        ring.strokeColor = UIColor.white.withAlphaComponent(0.9).cgColor
        ring.lineWidth = 4
        shade.fillRule = .evenOdd
        shade.fillColor = UIColor.black.withAlphaComponent(0.45).cgColor

        prompt.text = "Centre your face in the circle"
        prompt.textColor = .white
        prompt.font = .systemFont(ofSize: 17, weight: .semibold)
        prompt.textAlignment = .center
        prompt.numberOfLines = 0
        prompt.translatesAutoresizingMaskIntoConstraints = false

        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false

        preview.contentMode = .scaleAspectFill
        preview.clipsToBounds = true
        preview.isHidden = true
        preview.translatesAutoresizingMaskIntoConstraints = false

        let retake = Self.button("Retake", filled: false)
        retake.addTarget(self, action: #selector(retakeTapped), for: .touchUpInside)
        let use = Self.button("Use this photo", filled: true)
        use.addTarget(self, action: #selector(useTapped), for: .touchUpInside)
        actions = UIStackView(arrangedSubviews: [retake, use])
        actions.axis = .horizontal
        actions.spacing = 12
        actions.distribution = .fillEqually
        actions.isHidden = true
        actions.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(preview)
        view.layer.addSublayer(shade)
        view.layer.addSublayer(ring)
        view.addSubview(prompt)
        view.addSubview(cancel)
        view.addSubview(actions)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            preview.topAnchor.constraint(equalTo: view.topAnchor),
            preview.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            preview.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            preview.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            cancel.topAnchor.constraint(equalTo: guide.topAnchor, constant: 8),
            cancel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            prompt.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            prompt.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            prompt.bottomAnchor.constraint(equalTo: actions.topAnchor, constant: -24),
            actions.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 20),
            actions.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -20),
            actions.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -20),
            actions.heightAnchor.constraint(equalToConstant: 52),
        ])
        startCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
        let side = min(view.bounds.width * 0.72, 320)
        let rect = CGRect(x: (view.bounds.width - side) / 2, y: view.bounds.height * 0.42 - side / 2 - 40, width: side, height: side * 1.2)
        ring.path = UIBezierPath(ovalIn: rect).cgPath
        shade.frame = view.bounds
        let cutout = UIBezierPath(rect: view.bounds)
        cutout.append(UIBezierPath(ovalIn: rect))
        shade.path = cutout.cgPath
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        restoreBrightness()
    }

    /// Low light: everything outside the circle turns white and the screen goes
    /// to full brightness. It stays on for the rest of this scan (its own light
    /// brightens the face, so switching off on a bright reading would flicker).
    private func turnOnScreenLight() {
        guard !screenLight, !done else { return }
        screenLight = true
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.25)
        shade.fillColor = UIColor.white.cgColor
        ring.strokeColor = UIColor(white: 0.75, alpha: 1).cgColor
        CATransaction.commit()
        if captured == nil { prompt.textColor = .black }
        cancel.setTitleColor(.black, for: .normal)
        if let screen = view.window?.windowScene?.screen {
            if savedBrightness == nil { savedBrightness = screen.brightness }
            screen.brightness = 1
        }
        setNeedsStatusBarAppearanceUpdate()
    }

    private func restoreBrightness() {
        guard let saved = savedBrightness else { return }
        savedBrightness = nil
        view.window?.windowScene?.screen.brightness = saved
    }

    /// Average brightness (0-255) of a BGRA frame, sampled on a coarse grid.
    private static func luminance(_ pixels: CVPixelBuffer) -> Int {
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixels) else { return 128 }
        let width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels)
        let rowBytes = CVPixelBufferGetBytesPerRow(pixels)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var sum = 0, count = 0
        for y in stride(from: 0, to: height, by: 16) {
            let row = bytes + y * rowBytes
            for x in stride(from: 0, to: width, by: 16) {
                let i = x * 4  // B, G, R, A
                sum += (Int(row[i + 2]) * 77 + Int(row[i + 1]) * 150 + Int(row[i]) * 29) >> 8
                count += 1
            }
        }
        return count == 0 ? 128 : sum / count
    }

    private static func button(_ title: String, filled: Bool) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        button.setTitleColor(filled ? .black : .white, for: .normal)
        button.backgroundColor = filled ? .white : UIColor.white.withAlphaComponent(0.18)
        button.layer.cornerRadius = 14
        return button
    }

    private func startCamera() {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let input = try? AVCaptureDeviceInput(device: camera) else {
            prompt.text = "The front camera isn't available on this phone."
            return
        }
        session.beginConfiguration()
        session.sessionPreset = .hd1280x720
        if session.canAddInput(input) { session.addInput(input) }
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: frames)
        if session.canAddOutput(output) { session.addOutput(output) }
        if let connection = output.connection(with: .video) {
            if connection.isVideoOrientationSupported { connection.videoOrientation = .portrait }
            // The saved photo is the face as others see it, not a mirror image.
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = false
            }
        }
        session.commitConfiguration()
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        previewLayer = layer
        frames.async { [session] in session.startRunning() }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        frameCount += 1
        guard !frozen, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if !lightRequested, frameCount % 2 == 0 {
            darkStreak = Self.luminance(pixels) < Self.darkLuma ? darkStreak + 1 : 0
            if darkStreak >= Self.darkFrames {
                lightRequested = true
                DispatchQueue.main.async { self.turnOnScreenLight() }
            }
        }
        let image = CIImage(cvPixelBuffer: pixels)
        // Every frame (a blink can last a tenth of a second). The buffer is already upright.
        let request = VNDetectFaceLandmarksRequest()
        try? VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .up, options: [:]).perform([request])
        let faces = request.results ?? []
        guard faces.count == 1, let face = faces.first, face.boundingBox.width >= 0.28,
              let leftEye = face.landmarks?.leftEye, let rightEye = face.landmarks?.rightEye else {
            // A few frames without the face (a small head move during the blink) don't
            // restart it; a second face or about a quarter second away does.
            missedFaces += 1
            if faces.count > 1 || missedFaces >= 8 {
                say(faces.count > 1 ? "Only your face should be in the circle" : "Centre your face in the circle")
                resetBlink()
            }
            return
        }
        missedFaces = 0
        if face.boundingBox.width > 0.92 {
            say("Hold the phone a little further away")
            return
        }
        let size = CGSize(width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels))
        let openness = (Self.eyeOpenness(leftEye, size) + Self.eyeOpenness(rightEye, size)) / 2
        guard openness > 0 else { return }
        if !sawClosedEyes {
            openSamples.append(openness)
            if openSamples.count > 24 { openSamples.removeFirst() }
            // The usual open eye: the median of recent frames (one odd frame, wide or
            // closed, can't move it).
            let sorted = openSamples.sorted()
            openBaseline = sorted[sorted.count / 2]
            if openSamples.count >= 6, openness < openBaseline * Self.closedRatio {
                sawClosedEyes = true
                closedSince = frameCount
                say("Good - open your eyes again")
            } else {
                say("Now blink naturally - it captures on its own")
            }
            return
        }
        if openness < openBaseline * Self.openRatio {
            // Closed for more than about 3 seconds: start the blink again.
            if frameCount - closedSince > 90 { resetBlink(); say("Now blink naturally - it captures on its own") }
            return
        }
        guard let jpeg = Self.jpeg(from: image, context: context) else { return }
        frozen = true
        say("Got it, hold still…")
        DispatchQueue.main.async { self.show(jpeg) }
    }

    /// Frames queue only.
    private func resetBlink() {
        sawClosedEyes = false
        openSamples.removeAll()
        openBaseline = 0
    }

    /// Eye height / eye width from the eye outline, in image pixels.
    private static func eyeOpenness(_ eye: VNFaceLandmarkRegion2D, _ size: CGSize) -> CGFloat {
        let points = eye.pointsInImage(imageSize: size)
        guard points.count >= 4 else { return 0 }
        let xs = points.map(\.x), ys = points.map(\.y)
        let width = (xs.max() ?? 0) - (xs.min() ?? 0)
        return width > 0 ? ((ys.max() ?? 0) - (ys.min() ?? 0)) / width : 0
    }

    private func say(_ text: String) {
        DispatchQueue.main.async { if self.captured == nil, self.prompt.text != text { self.prompt.text = text } }
    }

    private func show(_ jpeg: Data) {
        guard captured == nil else { return }
        captured = jpeg
        frames.async { [session] in session.stopRunning() }
        preview.image = UIImage(data: jpeg)
        preview.isHidden = false
        ring.isHidden = true
        shade.isHidden = true
        prompt.textColor = .white
        actions.isHidden = false
        prompt.text = "Is your face clear and well lit?"
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// The full 720 x 1280 frame (the server needs face photos at least 600 px wide;
    /// shrinking to 900 px made them 506 wide and every one was rejected), quality 0.88,
    /// lower only if needed to stay under the server's 1.5 MB limit.
    private static func jpeg(from image: CIImage, context: CIContext) -> Data? {
        let longest = max(image.extent.width, image.extent.height)
        let scale = min(1, 1280 / longest)
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        let picture = UIImage(cgImage: cg)
        for quality in [0.88, 0.8, 0.7] {
            if let data = picture.jpegData(compressionQuality: quality), data.count < 1_400_000 { return data }
        }
        return nil
    }

    @objc private func retakeTapped() {
        captured = nil
        frames.async { self.resetBlink(); self.frozen = false }
        preview.isHidden = true
        ring.isHidden = false
        shade.isHidden = false
        prompt.textColor = screenLight ? .black : .white
        actions.isHidden = true
        prompt.text = "Centre your face in the circle"
        frames.async { [session] in session.startRunning() }
    }

    @objc private func useTapped() {
        guard let captured else { return }
        close(.success(captured))
    }

    @objc private func cancelTapped() { close(.failure(.cancelled)) }

    private func close(_ result: Result<Data, FaceCaptureError>) {
        guard !done else { return }
        done = true
        frames.async { [session] in session.stopRunning() }
        restoreBrightness()
        dismiss(animated: true) { self.finish(result) }
    }
}

// MARK: - Aadhaar QR

/// Scans the big secure QR printed on the Aadhaar card (Android uses Google's
/// code scanner). Payment and other short QR codes are ignored with a hint.
final class QRScanViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let finish: (String?) -> Void   // nil = cancelled
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "in.scraveit.delivery.qr")
    private let hint = UILabel()
    private var done = false

    init(finish: @escaping (String?) -> Void) {
        self.finish = finish
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        hint.text = "Point at the big QR code on your Aadhaar"
        hint.textColor = .white
        hint.font = .systemFont(ofSize: 17, weight: .semibold)
        hint.textAlignment = .center
        hint.numberOfLines = 0
        hint.translatesAutoresizingMaskIntoConstraints = false
        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)
        view.addSubview(cancel)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            cancel.topAnchor.constraint(equalTo: guide.topAnchor, constant: 8),
            cancel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            hint.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            hint.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -40),
        ])
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: camera) else {
            hint.text = "The camera isn't available on this phone."
            return
        }
        // The secure QR is dense: high resolution and close focus help.
        if (try? camera.lockForConfiguration()) != nil {
            if camera.isAutoFocusRangeRestrictionSupported { camera.autoFocusRangeRestriction = .near }
            if camera.isFocusModeSupported(.continuousAutoFocus) { camera.focusMode = .continuousAutoFocus }
            camera.unlockForConfiguration()
        }
        session.beginConfiguration()
        session.sessionPreset = session.canSetSessionPreset(.hd1920x1080) ? .hd1920x1080 : .high
        if session.canAddInput(input) { session.addInput(input) }
        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
        }
        session.commitConfiguration()
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        queue.async { [session] in session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.compactMap { $0 as? AVCaptureVideoPreviewLayer }.forEach { $0.frame = view.bounds }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !done else { return }
        for case let code as AVMetadataMachineReadableCodeObject in metadataObjects {
            guard let text = code.stringValue else { continue }
            if text.count >= 200 {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                close(text)
                return
            }
            hint.text = "That's not the Aadhaar secure QR. Use the big QR code on your Aadhaar."
        }
    }

    @objc private func cancelTapped() { close(nil) }

    private func close(_ value: String?) {
        guard !done else { return }
        done = true
        queue.async { [session] in session.stopRunning() }
        dismiss(animated: true) { self.finish(value) }
    }
}

/// Reads the Aadhaar QR from a screenshot or photo of an e-Aadhaar: the whole
/// picture first, then enlarged overlapping pieces (a full page shrinks the QR).
enum QRImageReader {
    static func read(_ image: CGImage) -> String {
        if let found = detect(image) { return found }
        let w = image.width, h = image.height
        for grid in [2, 3] {
            let tileW = w * 2 / (grid + 1), tileH = h * 2 / (grid + 1)
            for row in 0..<grid {
                for col in 0..<grid {
                    let rect = CGRect(x: col * (w - tileW) / max(1, grid - 1), y: row * (h - tileH) / max(1, grid - 1),
                                      width: tileW, height: tileH)
                    guard let piece = image.cropping(to: rect), let big = enlarge(piece, factor: 2) else { continue }
                    if let found = detect(big) { return found }
                }
            }
        }
        return ""
    }

    private static func detect(_ image: CGImage) -> String? {
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let texts = (request.results ?? []).compactMap { $0.payloadStringValue }
        return texts.max(by: { $0.count < $1.count }).flatMap { $0.count >= 200 ? $0 : nil }
    }

    private static func enlarge(_ image: CGImage, factor: Int) -> CGImage? {
        let width = image.width * factor, height = image.height * factor
        guard width <= 6000, height <= 6000,
              let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        ctx.interpolationQuality = .none
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()
    }
}
