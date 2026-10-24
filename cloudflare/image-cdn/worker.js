/**
 * Edge cache in front of Firebase Storage.
 *
 * Photos live in the Mumbai bucket (savrivo-app-mumbai, asia-south1) since
 * 23 Oct 2026; the original US bucket is still allowed for links an older
 * app build saved. This worker mirrors the Firebase Storage REST URL shape
 * (/v0/b/{bucket}/o/{path}) and keeps each public photo at Cloudflare's
 * nearest location (Chennai / Mumbai for India) after the first request, so
 * customers get it in about 0.1 s.
 *
 * Only public media (store and menu photos, admin-uploaded artwork) is cached.
 * Anything under private/ (identity documents, sealed-packet photos) is passed
 * straight through and never stored at the edge.
 *
 * Object bytes never change once uploaded (every upload writes a fresh
 * timestamped filename), so caching public photos for a year is safe.
 */

const ALLOWED_BUCKETS = ["savrivo-app-mumbai", "savrivo-app.firebasestorage.app"];
const PATH = /^\/v0\/b\/([^/]+)\/o\/(.+)$/;
const PUBLIC_PREFIXES = ["restaurants/", "admin-uploads/"];
const ORIGIN = "https://firebasestorage.googleapis.com";
const EDGE_TTL_SECONDS = 31536000; // 1 year - matches the immutable Cache-Control set at upload time.

export default {
  async fetch(request, _env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {status: 405});
    }
    const url = new URL(request.url);
    const match = PATH.exec(url.pathname);
    if (!match || !ALLOWED_BUCKETS.includes(decodeURIComponent(match[1]))) {
      return new Response("Not found", {status: 404});
    }
    let objectName = "";
    try { objectName = decodeURIComponent(match[2]); } catch { return new Response("Not found", {status: 404}); }
    if (!PUBLIC_PREFIXES.some((prefix) => objectName.startsWith(prefix))) {
      const passed = await fetch(ORIGIN + url.pathname + url.search, {cf: {cacheTtl: 0, cacheEverything: false}});
      const headers = new Headers(passed.headers);
      headers.set("Cache-Control", "private, no-store");
      headers.delete("set-cookie");
      return new Response(passed.body, {status: passed.status, headers});
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
