import Foundation
import CoreLocation
import UIKit

/// The iPhone version of the Android Rider app's TrackingService: while the
/// delivery partner is Online it tells dispatch where they are (presence), and
/// during a delivery it streams live location to the customer and sends the
/// GPS evidence the server uses for "Near you" / "Arrived". Same database paths,
/// payloads, intervals and rules as Android, so the server sees one kind of partner.
///
/// iPhone difference: there is no foreground service. Location keeps running in
/// the background while Online (iOS shows the blue location pill), and stops if
/// the partner swipes the app away; the page starts it again on the next open.
final class RiderTracker: NSObject, CLLocationManagerDelegate {
    /// Every Android app and the server use the Singapore database. The iOS
    /// Firebase file names the default one, so it is fixed here on purpose.
    static let databaseRoot = "https://savrivo-app-sg.asia-southeast1.firebasedatabase.app"
    static let projectId = "savrivo-app"
    #if DEBUG
    /// Debug builds only: a local fake server for the tracking self-test.
    private static let testServer = ProcessInfo.processInfo.environment["SCRAVEIT_SELFTEST_SERVER"]
    #else
    private static let testServer: String? = nil
    #endif
    private static var rtdbBase: String { testServer.map { $0 + "/rtdb" } ?? databaseRoot }
    private static var firestoreBase: String { testServer.map { $0 + "/firestore" } ?? "https://firestore.googleapis.com" }
    private static var secureTokenBase: String { testServer.map { $0 + "/securetoken" } ?? "https://securetoken.googleapis.com" }

    private static let heartbeatInterval: TimeInterval = 5
    private static let presenceIntervalMs: Int64 = 15_000
    private static let proximitySendMeters: Double = 1_200
    private static let campusProximitySendMeters: Double = 3_000
    private static let farProximityGapMs: Int64 = 9_000
    private static let jobCheckIntervalMs: Int64 = 30_000
    private static let maxLiveFixAge: TimeInterval = 60
    private static let maxUploadAccuracy: Double = 80
    private static let maxProximityAccuracy: Double = 50
    private static let normalUploadThrottleMs: Int64 = 2_000
    private static let nearUploadThrottleMs: Int64 = 1_000
    private static let stationaryMeters: Double = 15
    private static let stationaryCeilingMs: Int64 = 20_000
    private static let closeToDoorMeters: Double = 150

    enum Mode { case off, availability, delivery }

    /// state, message -> window.riderTrackingNativeState (Android's ACTION_STATE broadcast).
    var onState: ((String, String) -> Void)?
    /// Every usable fix, so the bridge can answer location checks without a second GPS request.
    var onFix: ((CLLocation) -> Void)?

    private let manager = CLLocationManager()
    private let network = DispatchQueue(label: "in.scraveit.delivery.tracking")
    private let credentials = Credentials()

    // Session (main thread only).
    private(set) var mode: Mode = .off
    private var customerId = ""
    private(set) var orderId = ""
    private var restaurantId = ""
    private var riderId = ""
    private var riderName = "Scraveit Partner"
    private var riderCity = ""
    private var phase = "pickup"
    private var customerLat = Double.nan
    private var customerLng = Double.nan
    private var lastProximityStatus = ""
    private var proximityCandidate = ""
    private var proximityFixCount = 0

    // Progress (main thread only).
    private(set) var lastLocation: CLLocation?
    private var lastUploadAt: Int64 = 0
    private var lastAcceptedFixTime: Date?
    private var lastHeartbeatAt: Int64 = 0
    private var lastPresenceAt: Int64 = 0
    private var lastJobCheckAt: Int64 = 0
    private var lastFarProximityAt: Int64 = 0
    private var missingJobChecks = 0
    private var deniedTrackingWrites = 0
    private var consecutiveSyncFailures = 0
    private var syncFailureReported = false
    private var authFailureAt: Int64 = 0
    private var stopping = false
    private var locationOff = false
    private var heartbeat: Timer?
    private var lastReportedState = ""
    private var lastReportedMessage = ""

    override init() {
        super.init()
        manager.delegate = self
        manager.pausesLocationUpdatesAutomatically = false
        manager.activityType = .otherNavigation
    }

    var isRunning: Bool { mode != .off && !stopping }

    // MARK: start / stop (from the page)

    func startAvailability(riderId: String, riderName: String, token: String, refreshToken: String,
                           apiKey: String, city: String) {
        start(availability: true, customerId: "", orderId: "", restaurantId: "", riderId: riderId,
              riderName: riderName, token: token, refreshToken: refreshToken, apiKey: apiKey,
              customerLat: .nan, customerLng: .nan, phase: "availability", city: city, orderStatus: "")
    }

    func startDelivery(customerId: String, orderId: String, restaurantId: String, riderId: String,
                       riderName: String, token: String, refreshToken: String, apiKey: String,
                       customerLat: Double, customerLng: Double, phase: String, city: String, orderStatus: String) {
        start(availability: false, customerId: customerId, orderId: orderId, restaurantId: restaurantId,
              riderId: riderId, riderName: riderName, token: token, refreshToken: refreshToken, apiKey: apiKey,
              customerLat: customerLat, customerLng: customerLng, phase: phase, city: city, orderStatus: orderStatus)
    }

    private func start(availability: Bool, customerId: String, orderId: String, restaurantId: String,
                       riderId: String, riderName: String, token: String, refreshToken: String, apiKey: String,
                       customerLat: Double, customerLng: Double, phase: String, city: String, orderStatus: String) {
        guard (availability || (Self.safeKey(customerId) && Self.safeKey(orderId))),
              Self.safeKey(riderId),
              restaurantId.isEmpty || Self.safeKey(restaurantId),
              Self.safeToken(token),
              refreshToken.isEmpty || Self.safeRefreshToken(refreshToken),
              apiKey.isEmpty || Self.safeApiKey(apiKey) else {
            publishState("stopped", "Active delivery credentials were invalid.")
            return
        }
        let nextMode: Mode = availability ? .availability : .delivery
        let nextPhase = availability ? "availability" : (phase == "delivery" ? "delivery" : "pickup")
        let duplicate = !stopping && mode == nextMode && self.customerId == customerId && self.orderId == orderId
            && self.restaurantId == restaurantId && self.riderId == riderId && self.phase == nextPhase
        credentials.set(token: token, refreshToken: refreshToken, apiKey: apiKey)
        if self.orderId != orderId {
            proximityCandidate = ""
            proximityFixCount = 0
            missingJobChecks = 0
            lastJobCheckAt = 0
        }
        mode = nextMode
        self.customerId = customerId
        self.orderId = orderId
        self.restaurantId = restaurantId
        self.riderId = riderId
        let name = riderName.trimmingCharacters(in: .whitespacesAndNewlines)
        self.riderName = name.isEmpty ? "Scraveit Partner" : String(name.prefix(80))
        riderCity = String(city.prefix(120))
        self.phase = nextPhase
        self.customerLat = customerLat.isFinite && customerLat != 0 ? customerLat : .nan
        self.customerLng = customerLng.isFinite && customerLng != 0 ? customerLng : .nan
        if !duplicate {
            lastProximityStatus = orderStatus == "Arrived" ? "Arrived" : orderStatus == "Near you" ? "Near you" : ""
        }
        stopping = false
        authFailureAt = 0
        if duplicate && heartbeat != nil { return }
        lastPresenceAt = 0
        lastHeartbeatAt = 0
        beginLocationUpdates()
        heartbeat?.invalidate()
        let timer = Timer(timeInterval: Self.heartbeatInterval, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        heartbeat = timer
        tick()
        publishState("active", availability ? "Online availability is active in the background."
                                            : "Live delivery tracking is active.")
    }

    func updateCredentials(token: String, refreshToken: String, apiKey: String) {
        guard Self.safeToken(token), Self.safeRefreshToken(refreshToken), Self.safeApiKey(apiKey), !riderId.isEmpty else {
            publishState("auth_required", "Secure tracking credentials could not be refreshed.")
            return
        }
        credentials.set(token: token, refreshToken: refreshToken, apiKey: apiKey)
        authFailureAt = 0
        publishState("active", "Secure live tracking session refreshed.")
    }

    /// Android's stop rule: only going offline (or a lost sign-in) ends tracking;
    /// a finished or cancelled delivery switches back to "online and available".
    func stop(reason: String) {
        if reason == "offline" || reason == "auth_expired" {
            requestStop(reason)
        } else if isRunning {
            switchToAvailability(expectedOrderId: "")
        }
    }

    private func switchToAvailability(expectedOrderId: String) {
        guard !stopping, mode == .delivery else { return }
        if !expectedOrderId.isEmpty && expectedOrderId != orderId { return }
        mode = .availability
        customerId = ""
        orderId = ""
        restaurantId = ""
        phase = "availability"
        customerLat = .nan
        customerLng = .nan
        lastProximityStatus = ""
        proximityCandidate = ""
        proximityFixCount = 0
        missingJobChecks = 0
        deniedTrackingWrites = 0
        lastJobCheckAt = 0
        lastPresenceAt = 0
        lastHeartbeatAt = 0
        applyAccuracy()
        publishState("active", "Online availability is active in the background.")
        tick()
    }

    private func requestStop(_ reason: String) {
        guard mode != .off, !stopping else { return }
        stopping = true
        heartbeat?.invalidate()
        heartbeat = nil
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        let safeReason = reason.isEmpty ? "stopped" : reason
        if safeReason == "location_off" {
            publishState("location_off", "Phone Location was turned off. Live tracking stopped.")
        }
        let snapshot = snapshotSession()
        network.async { [weak self] in
            guard let self else { return }
            self.publishFinalCloudState(safeReason, snapshot)
            DispatchQueue.main.async { self.finishStop(safeReason) }
        }
    }

    private func finishStop(_ reason: String) {
        // Going online again while this stop was on its way cancels it.
        guard stopping else { return }
        stopping = false
        mode = .off
        customerId = ""
        orderId = ""
        restaurantId = ""
        lastLocation = nil
        credentials.clear()
        if reason == "auth_expired" {
            publishState("auth_required", "Secure tracking session expired. Open Scraveit Partner to reconnect.")
        } else if reason != "location_off" {
            publishState("stopped", "Live delivery tracking stopped.")
        }
    }

    // MARK: location

    private func beginLocationUpdates() {
        let status = manager.authorizationStatus
        guard status == .authorizedWhenInUse || status == .authorizedAlways else {
            setLocationOff(true)
            return
        }
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        applyAccuracy()
        manager.startUpdatingLocation()
    }

    /// Waiting for offers needs a good position; a live delivery needs the best one.
    private func applyAccuracy() {
        if mode == .delivery {
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.distanceFilter = kCLDistanceFilterNone
        } else {
            manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            manager.distanceFilter = 5
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isRunning else { return }
        let status = manager.authorizationStatus
        if status == .authorizedWhenInUse || status == .authorizedAlways {
            if locationOff { setLocationOff(false) }
            beginLocationUpdates()
        } else if status == .denied || status == .restricted {
            setLocationOff(true)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .denied { setLocationOff(true) }
    }

    /// Location off keeps the partner online and waiting; it carries on when it's back.
    private func setLocationOff(_ off: Bool) {
        guard off != locationOff else { return }
        locationOff = off
        if off {
            publishState("location_off", "Phone Location is off. Turn it on to get delivery offers.")
        } else {
            publishState("active", mode == .availability ? "Online availability is active in the background."
                                                         : "Live delivery tracking is active.")
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations { handle(location) }
    }

    private func usable(_ location: CLLocation) -> Bool {
        let age = -location.timestamp.timeIntervalSinceNow
        guard location.horizontalAccuracy >= 0, location.horizontalAccuracy <= Self.maxUploadAccuracy,
              age <= Self.maxLiveFixAge, age >= -5,
              CLLocationCoordinate2DIsValid(location.coordinate) else { return false }
        if let previous = lastAcceptedFixTime, location.timestamp <= previous { return false }
        // Same rule as Android's mock-provider check (the simulator's own positions are simulated).
        #if !targetEnvironment(simulator)
        if #available(iOS 15.0, *), let info = location.sourceInformation, info.isSimulatedBySoftware { return false }
        #endif
        return true
    }

    private var nearDestination: Bool { lastProximityStatus == "Near you" || lastProximityStatus == "Arrived" }

    private func distanceToDoor(_ location: CLLocation) -> Double? {
        guard !customerLat.isNaN, !customerLng.isNaN else { return nil }
        return location.distance(from: CLLocation(latitude: customerLat, longitude: customerLng))
    }

    private func handle(_ location: CLLocation) {
        guard isRunning, usable(location) else { return }
        onFix?(location)
        if locationOff { setLocationOff(false) }
        let now = Self.nowMs()
        let throttle = nearDestination ? Self.nearUploadThrottleMs : Self.normalUploadThrottleMs
        guard now - lastUploadAt >= throttle else { return }
        let door = phase == "delivery" ? distanceToDoor(location) : nil
        let closeToDoor = (door ?? .infinity) <= Self.closeToDoorMeters
        if !nearDestination && !closeToDoor, let last = lastLocation, now - lastUploadAt < Self.stationaryCeilingMs,
           location.distance(from: last) < Self.stationaryMeters { return }
        lastUploadAt = now
        lastLocation = location
        lastAcceptedFixTime = location.timestamp
        lastHeartbeatAt = now

        let snapshot = snapshotSession()
        // Customer's door: every reading for the last 1.2 km; one per 9 s from 3 km (campus gates).
        var sendProximity = false
        if mode == .delivery, phase == "delivery", let door {
            let near = door <= Self.proximitySendMeters
            let far = !near && door <= Self.campusProximitySendMeters && now - lastFarProximityAt >= Self.farProximityGapMs
            if far { lastFarProximityAt = now }
            sendProximity = near || far
        }
        let evidence = proximityEvidence(location, door: door, now: now)
        let presenceDue = now - lastPresenceAt >= Self.presenceIntervalMs
        if presenceDue { lastPresenceAt = now }
        let fix = Fix(lat: location.coordinate.latitude, lng: location.coordinate.longitude,
                      accuracy: location.horizontalAccuracy,
                      bearing: location.course >= 0 ? location.course : 0, at: now)

        network.async { [weak self] in
            guard let self else { return }
            var trackingResult: Int?
            var evidenceWritten = false
            if snapshot.mode == .delivery, !snapshot.orderId.isEmpty {
                let payload = self.trackingPayload(snapshot, fix)
                let code = self.writePatch("/feastly/tracking/\(snapshot.orderId)", payload)
                trackingResult = code
                if Self.ok(code) {
                    if sendProximity { _ = self.writePatch("/feastly/trackingProximity/\(snapshot.orderId)", payload) }
                    if let evidence {
                        evidenceWritten = Self.ok(self.writePatch("/feastly/tracking/\(snapshot.orderId)/proximityEvidence",
                                                                 self.evidencePayload(evidence, snapshot)))
                    }
                }
            }
            var presenceCode: Int?
            if presenceDue { presenceCode = self.writePatch("/feastly/riderPresence/\(snapshot.riderId)", self.presencePayload(snapshot, fix)) }
            DispatchQueue.main.async {
                if let presenceCode, !Self.ok(presenceCode) { self.lastPresenceAt = 0 }
                if let trackingResult, snapshot.orderId == self.orderId {
                    if Self.ok(trackingResult) {
                        self.deniedTrackingWrites = 0
                    } else if trackingResult == 403 {
                        self.deniedTrackingWrites += 1
                        if self.deniedTrackingWrites >= 2 { self.switchToAvailability(expectedOrderId: snapshot.orderId) }
                    }
                }
                if let evidence, evidenceWritten, snapshot.orderId == self.orderId {
                    self.lastProximityStatus = evidence.candidate
                    self.proximityCandidate = ""
                    self.proximityFixCount = 0
                }
            }
        }
    }

    /// Two fixes in a row inside 700 m ("Near you") or 100 m ("Arrived"): signed-in GPS
    /// evidence. The server checks the partner, freshness, accuracy and distance before
    /// it moves the order on.
    private func proximityEvidence(_ location: CLLocation, door: Double?, now: Int64) -> Evidence? {
        let age = -location.timestamp.timeIntervalSinceNow
        guard mode == .delivery, phase == "delivery", let door,
              location.horizontalAccuracy <= Self.maxProximityAccuracy, age <= 20 else { return nil }
        let candidate = door <= 100 ? "Arrived" : door <= 700 ? "Near you" : ""
        if candidate.isEmpty || lastProximityStatus == "Arrived" {
            proximityCandidate = ""
            proximityFixCount = 0
            return nil
        }
        if candidate == proximityCandidate { proximityFixCount += 1 } else { proximityCandidate = candidate; proximityFixCount = 1 }
        guard proximityFixCount >= 2, candidate != lastProximityStatus else { return nil }
        return Evidence(candidate: candidate, distance: door, accuracy: location.horizontalAccuracy,
                        fixes: proximityFixCount, at: now)
    }

    // MARK: heartbeat, presence and the job check

    private func tick() {
        guard isRunning, !riderId.isEmpty else { return }
        let status = manager.authorizationStatus
        if status == .denied || status == .restricted { setLocationOff(true) }
        let now = Self.nowMs()
        // With Location off the signal goes old on purpose: an old position must not win offers.
        if !locationOff && now - lastHeartbeatAt >= Int64(Self.heartbeatInterval * 1000) - 1_000
            && now - lastPresenceAt >= Self.presenceIntervalMs - 1_000 {
            lastPresenceAt = now
            lastHeartbeatAt = now
            let snapshot = snapshotSession()
            let fix = lastLocation.map { Fix(lat: $0.coordinate.latitude, lng: $0.coordinate.longitude,
                                             accuracy: $0.horizontalAccuracy, bearing: 0, at: now) }
            network.async { [weak self] in
                guard let self else { return }
                let code = self.writePatch("/feastly/riderPresence/\(snapshot.riderId)",
                                           self.presencePayload(snapshot, fix, at: now))
                if !Self.ok(code) { DispatchQueue.main.async { self.lastPresenceAt = 0 } }
            }
        }
        if mode == .delivery, !orderId.isEmpty, now - lastJobCheckAt >= Self.jobCheckIntervalMs {
            lastJobCheckAt = now
            verifyActiveJob()
        }
    }

    /// The partner's job card, read with their own sign-in: a finished or
    /// reassigned job switches back to availability; the server's phase wins.
    private func verifyActiveJob() {
        let checked = orderId, rider = riderId, customer = customerId
        network.async { [weak self] in
            guard let self else { return }
            let (code, body) = self.readFirestore("riderJobs/\(rider)_\(checked)")
            DispatchQueue.main.async {
                guard self.isRunning, self.mode == .delivery, self.orderId == checked else { return }
                if code == 404 {
                    self.missingJobChecks += 1
                    if self.missingJobChecks >= 2 { self.switchToAvailability(expectedOrderId: checked) }
                    return
                }
                guard Self.ok(code) else { return }
                guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
                    self.publishState("sync_error", "The active delivery record could not be verified.")
                    return
                }
                let fields = json["fields"] as? [String: Any] ?? [:]
                let text = { (key: String) -> String in ((fields[key] as? [String: Any])?["stringValue"] as? String) ?? "" }
                let status = text("status"), orderStatus = text("orderStatus")
                if text("customerId") != customer || status == "completed" || status == "cancelled"
                    || orderStatus == "Delivered" || orderStatus == "Cancelled" {
                    self.switchToAvailability(expectedOrderId: checked)
                    return
                }
                self.missingJobChecks = 0
                if orderStatus == "Arrived" { self.lastProximityStatus = "Arrived" }
                else if orderStatus == "Near you" && self.lastProximityStatus != "Arrived" { self.lastProximityStatus = "Near you" }
                let serverPhase = text("phase")
                self.phase = (serverPhase == "delivery" || serverPhase == "arrived") ? "delivery" : "pickup"
            }
        }
    }

    /// Offline (or Location off): tell dispatch at once. The order's own record is
    /// written separately, since the server may already have withdrawn that right.
    private func publishFinalCloudState(_ reason: String, _ s: Session) {
        guard !s.riderId.isEmpty, reason != "auth_expired", !credentials.token.isEmpty else { return }
        let now = Self.nowMs()
        let offline = reason == "offline" || reason == "location_off"
        let base = "riderPresence/\(s.riderId)/"
        let changes: [String: Any] = [
            base + "online": !offline, base + "riderId": s.riderId, base + "riderName": s.riderName,
            base + "updatedAt": now, base + "city": s.city, base + "activeOrderId": "",
        ]
        _ = writePatch("/feastly", Self.json(changes))
        if offline, s.mode == .delivery, !s.orderId.isEmpty {
            _ = writePatch("/feastly/tracking/\(s.orderId)",
                           Self.json(["status": reason == "location_off" ? "location_off" : "stopped", "updatedAt": now]))
        }
    }

    // MARK: payloads

    private struct Session {
        let mode: Mode, riderId: String, riderName: String, city: String
        let customerId: String, orderId: String, phase: String
    }

    private struct Fix { let lat: Double, lng: Double, accuracy: Double, bearing: Double, at: Int64 }

    private struct Evidence { let candidate: String, distance: Double, accuracy: Double, fixes: Int, at: Int64 }

    private func snapshotSession() -> Session {
        Session(mode: mode, riderId: riderId, riderName: riderName, city: riderCity,
                customerId: customerId, orderId: orderId, phase: phase)
    }

    private func trackingPayload(_ s: Session, _ f: Fix) -> String {
        Self.json(["customerId": s.customerId, "orderId": s.orderId, "riderId": s.riderId, "riderName": s.riderName,
                   "lat": Self.round(f.lat, 7), "lng": Self.round(f.lng, 7), "accuracy": Self.round(f.accuracy, 1),
                   "bearing": Self.round(f.bearing, 1), "updatedAt": f.at, "status": "live", "phase": s.phase])
    }

    private func presencePayload(_ s: Session, _ f: Fix?, at: Int64? = nil) -> String {
        var payload: [String: Any] = [
            "online": true, "riderId": s.riderId, "riderName": s.riderName, "updatedAt": at ?? f?.at ?? Self.nowMs(),
            "city": s.city, "activeOrderId": s.orderId.count <= 80 ? s.orderId : "",
        ]
        if let f, f.accuracy >= 0 {
            payload["lat"] = Self.round(f.lat, 7)
            payload["lng"] = Self.round(f.lng, 7)
            payload["accuracy"] = Self.round(f.accuracy, 1)
        }
        return Self.json(payload)
    }

    private func evidencePayload(_ e: Evidence, _ s: Session) -> String {
        Self.json(["candidate": e.candidate, "distanceMeters": Self.round(e.distance, 1), "accuracy": Self.round(e.accuracy, 1),
                   "consecutiveFixes": e.fixes, "detectedAt": e.at, "riderId": s.riderId, "orderId": s.orderId,
                   "phase": "delivery", "source": "gps"])
    }

    // MARK: network (on the `network` queue only)

    /// PATCH with up to 3 tries, a token refresh on 401, and the same sync
    /// warnings Android shows. Returns the last HTTP status (-1 = no answer).
    private func writePatch(_ path: String, _ body: String) -> Int {
        var code = -1
        var attempt = 0
        while attempt < 3 {
            code = sendPatch(path, body)
            if Self.ok(code) {
                DispatchQueue.main.async {
                    self.consecutiveSyncFailures = 0
                    if self.authFailureAt > 0 || self.syncFailureReported {
                        self.authFailureAt = 0
                        self.syncFailureReported = false
                        self.publishState("active", "Live delivery tracking recovered.")
                    }
                }
                return code
            }
            if code == 401 {
                let refresh = refreshIdToken()
                if refresh.ok { attempt += 1; continue }
                // No internet isn't a lost sign-in: the next heartbeat just tries again.
                if refresh.refused { DispatchQueue.main.async { self.handleAuthenticationFailure() } }
                return code
            }
            if !Self.transient(code) || attempt == 2 { break }
            Thread.sleep(forTimeInterval: attempt == 0 ? 0.45 : 1.2)
            attempt += 1
        }
        let final = code
        DispatchQueue.main.async {
            if final == 403 {
                self.consecutiveSyncFailures = 0
                self.syncFailureReported = true
                self.publishState("sync_error", "Live tracking permission was rejected. Ask Scraveit support to verify this assignment.")
                return
            }
            self.consecutiveSyncFailures += 1
            if self.consecutiveSyncFailures >= 2 {
                self.syncFailureReported = true
                self.publishState("sync_error", "Live tracking could not reach Scraveit. It will retry automatically.")
            }
        }
        return code
    }

    private func sendPatch(_ path: String, _ body: String) -> Int {
        let token = credentials.token
        guard !token.isEmpty,
              let auth = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let url = URL(string: Self.rtdbBase + path + ".json?auth=" + auth) else { return -1 }
        var request = URLRequest(url: url, timeoutInterval: 9)
        request.httpMethod = "POST"
        request.setValue("PATCH", forHTTPHeaderField: "X-HTTP-Method-Override")
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(body.utf8)
        return Self.send(request).code
    }

    private func readFirestore(_ documentPath: String) -> (Int, Data) {
        var result: (code: Int, body: Data) = (-1, Data())
        var attempt = 0
        while attempt < 3 {
            guard let url = URL(string: "\(Self.firestoreBase)/v1/projects/\(Self.projectId)/databases/(default)/documents/\(documentPath)") else { break }
            var request = URLRequest(url: url, timeoutInterval: 9)
            request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
            result = Self.send(request)
            if Self.ok(result.code) || result.code == 404 { return (result.code, result.body) }
            if result.code == 401 {
                let refresh = refreshIdToken()
                if refresh.ok { attempt += 1; continue }
                if refresh.refused { DispatchQueue.main.async { self.handleAuthenticationFailure() } }
                return (result.code, Data())
            }
            if !Self.transient(result.code) || attempt == 2 { break }
            Thread.sleep(forTimeInterval: attempt == 0 ? 0.45 : 1.2)
            attempt += 1
        }
        return (result.code, Self.ok(result.code) ? result.body : Data())
    }

    /// A fresh ID token from the refresh token (Firebase's secure token API).
    private func refreshIdToken() -> (ok: Bool, refused: Bool) {
        let current = credentials.snapshot()
        guard Self.safeRefreshToken(current.refreshToken), Self.safeApiKey(current.apiKey),
              let url = URL(string: "\(Self.secureTokenBase)/v1/token?key=\(current.apiKey)"),
              let refresh = current.refreshToken.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            return (false, true)
        }
        var request = URLRequest(url: url, timeoutInterval: 9)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("grant_type=refresh_token&refresh_token=\(refresh)".utf8)
        let (code, body) = Self.send(request)
        guard Self.ok(code) else {
            return (false, code >= 400 && code < 500 && code != 408 && code != 429)
        }
        guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let token = json["id_token"] as? String, Self.safeToken(token) else { return (false, false) }
        let nextRefresh = (json["refresh_token"] as? String) ?? current.refreshToken
        guard Self.safeRefreshToken(nextRefresh) else { return (false, false) }
        credentials.set(token: token, refreshToken: nextRefresh, apiKey: current.apiKey)
        DispatchQueue.main.async { self.authFailureAt = 0 }
        return (true, false)
    }

    /// The sign-in was refused: say so, and stop after a minute unless the page reconnects it.
    private func handleAuthenticationFailure() {
        guard authFailureAt == 0, isRunning else { return }
        let failure = Self.nowMs()
        authFailureAt = failure
        publishState("auth_required", "Refreshing the secure delivery session…")
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            guard let self, self.isRunning, self.authFailureAt == failure else { return }
            self.requestStop("auth_expired")
        }
    }

    // MARK: helpers

    private func publishState(_ state: String, _ message: String) {
        guard state != lastReportedState || message != lastReportedMessage else { return }
        lastReportedState = state
        lastReportedMessage = message
        onState?(state, message)
    }

    /// Blocking request for the serial network queue (Android uses blocking HTTP on one thread too).
    private static func send(_ request: URLRequest) -> (code: Int, body: Data) {
        let done = DispatchSemaphore(value: 0)
        var result: (Int, Data) = (-1, Data())
        URLSession.shared.dataTask(with: request) { data, response, _ in
            result = ((response as? HTTPURLResponse)?.statusCode ?? -1, data ?? Data())
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 12)
        return result
    }

    private static func ok(_ code: Int) -> Bool { code >= 200 && code < 300 }
    private static func transient(_ code: Int) -> Bool { code < 0 || code == 408 || code == 425 || code == 429 || code >= 500 }
    static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private static func round(_ value: Double, _ places: Int) -> Double {
        let scale = pow(10.0, Double(places)); return (value * scale).rounded() / scale
    }
    private static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    static func safeKey(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 128 && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }
    static func safeToken(_ value: String) -> Bool {
        value.count >= 32 && value.count <= 8192 && value.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
    }
    static func safeRefreshToken(_ value: String) -> Bool {
        value.count >= 32 && value.count <= 8192 && value.range(of: "^[A-Za-z0-9._~-]+$", options: .regularExpression) != nil
    }
    static func safeApiKey(_ value: String) -> Bool {
        value.count >= 20 && value.count <= 128 && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }
}

/// Sign-in tokens shared by the main thread and the network queue.
private final class Credentials {
    private let lock = NSLock()
    private var values = (token: "", refreshToken: "", apiKey: "")

    var token: String { lock.lock(); defer { lock.unlock() }; return values.token }
    func snapshot() -> (token: String, refreshToken: String, apiKey: String) { lock.lock(); defer { lock.unlock() }; return values }
    func set(token: String, refreshToken: String, apiKey: String) { lock.lock(); values = (token, refreshToken, apiKey); lock.unlock() }
    func clear() { set(token: "", refreshToken: "", apiKey: "") }
}
