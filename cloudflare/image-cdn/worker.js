/**
 * Edge cache in front of Firebase Storage for one bucket only.
 *
 * Why this exists: savrivo-app's Realtime Database (and its Storage bucket,
 * provisioned alongside it) live in us-central1, while customers are in
 * India. Every image request pays a fixed cross-continent round trip no
 * matter how small the file is. This worker mirrors the exact Firebase
 * Storage REST URL shape (/v0/b/{bucket}/o/{path}) at a domain Cloudflare
 * fronts, and caches each object at the edge after the first request - so
 * every customer after the first one gets the image from a nearby edge
 * location instead of us-central1.
 *
 * Object bytes never change once uploaded (every upload path in this repo
 * writes a fresh timestamped filename - see thumbPath()/prepareUploadFile()
 * in the native apps), so caching indefinitely at the edge is safe: there is
 * no staleness case to worry about.
 */

const ALLOWED_BUCKET = "savrivo-app.firebasestorage.app";
const ALLOWED_PATH = new RegExp(`^/v0/b/${ALLOWED_BUCKET.replace(/\./g, "\\.")}/o/.+$`);
const ORIGIN = "https://firebasestorage.googleapis.com";
const EDGE_TTL_SECONDS = 31536000; // 1 year - matches the immutable Cache-Control set at upload time.

export default {
  async fetch(request, _env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {status: 405});
    }
    const url = new URL(request.url);
    if (!ALLOWED_PATH.test(url.pathname)) {
      return new Response("Not found", {status: 404});
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const originUrl = ORIGIN + url.pathname + url.search;
    const originResponse = await fetch(originUrl, {
      cf: {cacheEverything: true, cacheTtl: EDGE_TTL_SECONDS},
    });
    if (!originResponse.ok) return originResponse;

    const headers = new Headers(originResponse.headers);
    headers.set("Cache-Control", `public, max-age=${EDGE_TTL_SECONDS}, immutable`);
    headers.delete("set-cookie");
    const response = new Response(originResponse.body, {status: originResponse.status, headers});
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
