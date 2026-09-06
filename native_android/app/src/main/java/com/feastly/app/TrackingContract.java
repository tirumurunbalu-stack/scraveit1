package com.feastly.app;

import com.google.android.gms.maps.model.LatLng;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Validates the small, privacy-scoped contract shared by the WebView, RTDB and native map. */
final class TrackingContract {
  static final long FRESH_LOCATION_MS = 45_000L;
  static final int MAX_LAUNCH_JSON_CHARS = 64_000;
  private static final int MAX_POLYLINE_CHARS = 60_000;
  private static final int MAX_ROUTE_POINTS = 5_000;

  private TrackingContract() { }

  static final class GeoPoint {
    final double lat;
    final double lng;

    GeoPoint(double lat, double lng) {
      this.lat = lat;
      this.lng = lng;
    }

    LatLng asLatLng() { return new LatLng(lat, lng); }
  }

  static final class LaunchData {
    final String orderId;
    final String restaurantName;
    final String riderName;
    final String orderStatus;
    final boolean darkTheme;
    final GeoPoint restaurant;
    final GeoPoint customer;
    final JSONObject initialTracking;

    LaunchData(String orderId, String restaurantName, String riderName, String orderStatus,
               boolean darkTheme, GeoPoint restaurant, GeoPoint customer, JSONObject initialTracking) {
      this.orderId = orderId;
      this.restaurantName = restaurantName;
      this.riderName = riderName;
      this.orderStatus = orderStatus;
      this.darkTheme = darkTheme;
      this.restaurant = restaurant;
      this.customer = customer;
      this.initialTracking = initialTracking;
    }
  }

  static final class Frame {
    final GeoPoint rider;
    final long updatedAt;
    final double accuracy;
    final String sharingStatus;
    final List<LatLng> routePoints;
    final long routeGeneratedAt;
    final long durationSeconds;
    final long distanceMeters;

    Frame(GeoPoint rider, long updatedAt, double accuracy, String sharingStatus,
          List<LatLng> routePoints, long routeGeneratedAt, long durationSeconds, long distanceMeters) {
      this.rider = rider;
      this.updatedAt = updatedAt;
      this.accuracy = accuracy;
      this.sharingStatus = sharingStatus;
      this.routePoints = routePoints;
      this.routeGeneratedAt = routeGeneratedAt;
      this.durationSeconds = durationSeconds;
      this.distanceMeters = distanceMeters;
    }

    boolean isFresh(long now) {
      return rider != null && updatedAt > 0 && updatedAt <= now + 5_000L
          && now - updatedAt < FRESH_LOCATION_MS;
    }
  }

  static LaunchData parseLaunch(String rawJson, String expectedOrderId) throws IllegalArgumentException {
    if (!validOrderId(expectedOrderId) || rawJson == null || rawJson.length() > MAX_LAUNCH_JSON_CHARS) {
      throw new IllegalArgumentException("Invalid live-tracking launch request");
    }
    try {
      JSONObject root = new JSONObject(rawJson);
      String orderId = clean(root.optString("orderId"), 128);
      if (!expectedOrderId.equals(orderId)) throw new IllegalArgumentException("Order mismatch");
      JSONObject restaurant = root.optJSONObject("restaurant");
      JSONObject customer = root.optJSONObject("customer");
      JSONObject tracking = root.optJSONObject("tracking");
      return new LaunchData(
          orderId,
          fallback(clean(root.optString("restaurantName"), 120), "Restaurant"),
          clean(root.optString("riderName"), 120),
          fallback(clean(root.optString("orderStatus"), 64), "Assigned"),
          "dark".equals(root.optString("theme")),
          pointFromObject(restaurant),
          pointFromObject(customer),
          tracking == null ? new JSONObject() : new JSONObject(tracking.toString()));
    } catch (IllegalArgumentException error) {
      throw error;
    } catch (Exception error) {
      throw new IllegalArgumentException("Malformed live-tracking launch request", error);
    }
  }

  static Frame frame(JSONObject tracking) {
    JSONObject safe = tracking == null ? new JSONObject() : tracking;
    GeoPoint rider = pointFromObject(safe);
    if (rider == null) rider = pointFromObject(safe.optJSONObject("location"));
    if (rider == null) rider = pointFromObject(safe.optJSONObject("riderLocation"));
    long updatedAt = positiveLong(safe.opt("updatedAt"));
    if (updatedAt == 0) updatedAt = positiveLong(safe.opt("timestamp"));
    double accuracy = finiteNonNegative(safe.opt("accuracy"));
    String status = clean(safe.optString("status"), 40);

    JSONObject route = safe.optJSONObject("route");
    List<LatLng> points = routePoints(route, safe.optJSONArray("routePoints"));
    long routeGeneratedAt = route == null ? 0 : positiveLong(route.opt("generatedAt"));
    long durationSeconds = route == null ? 0 : positiveLong(route.opt("durationSeconds"));
    long distanceMeters = route == null ? 0 : positiveLong(route.opt("distanceMeters"));
    if (durationSeconds == 0) durationSeconds = positiveLong(safe.opt("etaSeconds"));
    if (distanceMeters == 0) distanceMeters = positiveLong(safe.opt("distanceMeters"));
    return new Frame(rider, updatedAt, accuracy, status, points, routeGeneratedAt,
        durationSeconds, distanceMeters);
  }

  static JSONObject applyFirebaseEvent(JSONObject current, String eventName, JSONObject envelope) {
    JSONObject base = cloneObject(current);
    if (envelope == null || (!"put".equals(eventName) && !"patch".equals(eventName))) return base;
    String path = envelope.optString("path", "/");
    Object data = envelope.opt("data");
    if ("/".equals(path) || path.length() == 0) {
      if ("put".equals(eventName)) {
        return data instanceof JSONObject ? cloneObject((JSONObject) data) : new JSONObject();
      }
      if (data instanceof JSONObject) merge(base, (JSONObject) data);
      return base;
    }
    String[] rawParts = path.split("/");
    List<String> parts = new ArrayList<>();
    for (String part : rawParts) if (!part.isEmpty() && !"..".equals(part)) parts.add(part);
    if (parts.isEmpty() || parts.size() > 8) return base;
    JSONObject parent = base;
    for (int index = 0; index < parts.size() - 1; index++) {
      String key = parts.get(index);
      JSONObject child = parent.optJSONObject(key);
      if (child == null) {
        child = new JSONObject();
        try { parent.put(key, child); } catch (Exception ignored) { return base; }
      }
      parent = child;
    }
    String leaf = parts.get(parts.size() - 1);
    try {
      if (data == null || data == JSONObject.NULL) parent.remove(leaf);
      else if ("patch".equals(eventName) && data instanceof JSONObject) {
        JSONObject target = parent.optJSONObject(leaf);
        if (target == null) target = new JSONObject();
        merge(target, (JSONObject) data);
        parent.put(leaf, target);
      } else parent.put(leaf, data);
    } catch (Exception ignored) { }
    return base;
  }

  static boolean validOrderId(String value) {
    return value != null && value.matches("[A-Za-z0-9_-]{1,128}");
  }

  private static List<LatLng> routePoints(JSONObject route, JSONArray legacyPoints) {
    JSONArray points = route == null ? null : route.optJSONArray("points");
    if (points == null) points = legacyPoints;
    List<LatLng> parsed = parsePoints(points);
    if (!parsed.isEmpty()) return parsed;
    if (route == null) return Collections.emptyList();
    String encoded = route.optString("encodedPolyline", "");
    if (encoded.isEmpty()) encoded = route.optString("encodedPolyline5", "");
    if (encoded.isEmpty()) encoded = route.optString("polyline", "");
    return decodePolyline(encoded);
  }

  private static List<LatLng> parsePoints(JSONArray values) {
    if (values == null || values.length() < 2 || values.length() > MAX_ROUTE_POINTS) {
      return Collections.emptyList();
    }
    List<LatLng> result = new ArrayList<>();
    for (int index = 0; index < values.length(); index++) {
      Object raw = values.opt(index);
      GeoPoint point = raw instanceof JSONObject ? pointFromObject((JSONObject) raw) : null;
      if (point == null && raw instanceof JSONArray) {
        JSONArray pair = (JSONArray) raw;
        point = pair.length() >= 2 ? point(pair.opt(0), pair.opt(1)) : null;
      }
      if (point == null) return Collections.emptyList();
      result.add(point.asLatLng());
    }
    return result;
  }

  private static List<LatLng> decodePolyline(String encoded) {
    if (encoded == null || encoded.length() < 2 || encoded.length() > MAX_POLYLINE_CHARS) {
      return Collections.emptyList();
    }
    List<LatLng> points = new ArrayList<>();
    int index = 0;
    int lat = 0;
    int lng = 0;
    try {
      while (index < encoded.length() && points.size() < MAX_ROUTE_POINTS) {
        int[] latitude = decodeValue(encoded, index);
        index = latitude[1];
        int[] longitude = decodeValue(encoded, index);
        index = longitude[1];
        lat += latitude[0];
        lng += longitude[0];
        GeoPoint point = point(lat / 1e5d, lng / 1e5d);
        if (point == null) return Collections.emptyList();
        points.add(point.asLatLng());
      }
      return points.size() >= 2 ? points : Collections.emptyList();
    } catch (IllegalArgumentException ignored) {
      return Collections.emptyList();
    }
  }

  private static int[] decodeValue(String encoded, int start) {
    int result = 0;
    int shift = 0;
    int index = start;
    int value;
    do {
      if (index >= encoded.length() || shift > 30) throw new IllegalArgumentException("Bad polyline");
      value = encoded.charAt(index++) - 63;
      if (value < 0) throw new IllegalArgumentException("Bad polyline");
      result |= (value & 0x1f) << shift;
      shift += 5;
    } while (value >= 0x20);
    int delta = (result & 1) != 0 ? ~(result >> 1) : result >> 1;
    return new int[]{delta, index};
  }

  private static GeoPoint pointFromObject(JSONObject object) {
    return object == null ? null : point(object.opt("lat"), object.opt("lng"));
  }

  private static GeoPoint point(Object rawLat, Object rawLng) {
    try {
      double lat = Double.parseDouble(String.valueOf(rawLat));
      double lng = Double.parseDouble(String.valueOf(rawLng));
      if (!Double.isFinite(lat) || !Double.isFinite(lng) || lat < -90 || lat > 90
          || lng < -180 || lng > 180) return null;
      return new GeoPoint(lat, lng);
    } catch (Exception ignored) {
      return null;
    }
  }

  private static long positiveLong(Object value) {
    try {
      long parsed = (long) Double.parseDouble(String.valueOf(value));
      return parsed > 0 ? parsed : 0;
    } catch (Exception ignored) {
      return 0;
    }
  }

  private static double finiteNonNegative(Object value) {
    try {
      double parsed = Double.parseDouble(String.valueOf(value));
      return Double.isFinite(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : 0;
    } catch (Exception ignored) {
      return 0;
    }
  }

  private static String clean(String value, int max) {
    if (value == null) return "";
    String cleaned = value.trim().replaceAll("[\\p{Cntrl}&&[^\\n\\t]]", "");
    return cleaned.substring(0, Math.min(max, cleaned.length()));
  }

  private static String fallback(String value, String fallback) {
    return value == null || value.isEmpty() ? fallback : value;
  }

  private static JSONObject cloneObject(JSONObject value) {
    try { return value == null ? new JSONObject() : new JSONObject(value.toString()); }
    catch (Exception ignored) { return new JSONObject(); }
  }

  private static void merge(JSONObject target, JSONObject patch) {
    if (target == null || patch == null) return;
    for (java.util.Iterator<String> keys = patch.keys(); keys.hasNext();) {
      String key = keys.next();
      Object value = patch.opt(key);
      if (value == null || value == JSONObject.NULL) target.remove(key);
      else {
        try { target.put(key, value); } catch (Exception ignored) { }
      }
    }
  }
}
