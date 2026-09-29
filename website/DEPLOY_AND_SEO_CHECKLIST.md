# SCRAVEIT SEO Deployment Checklist

Prepared on 2026-09-21 for the official domains `www.scraveit.in` and `www.scraveit.com`.

## Current Live Status

- Deployed to Firebase Hosting site `scraveit-in` in project `savrivo-app` on 2026-09-21.
- `https://www.scraveit.in/` returns the site with HTTP 200.
- `https://scraveit.in/` redirects to `https://www.scraveit.in/`.
- `https://scraveit.com/` and `https://www.scraveit.com/` redirect to `https://www.scraveit.in/`.
- DNS points to Firebase Hosting: `scraveit.in` uses `199.36.158.100`, and both `www.scraveit.in` and `www.scraveit.com` resolve through `scraveit-in.web.app`.
- `https://www.scraveit.in/robots.txt` returns HTTP 200.
- `https://www.scraveit.in/sitemap.xml` returns HTTP 200.
- `https://www.scraveit.in/about` returns HTTP 200.
- Google Search Console URL-prefix property `https://www.scraveit.in/` is verified using the HTML file verification method.
- `https://www.scraveit.in/sitemap.xml` has been submitted in Google Search Console.
- Indexing was requested for `https://www.scraveit.in/` and `https://www.scraveit.in/about`.
- On 2026-09-23, Search Console showed both `https://www.scraveit.in/` and `https://www.scraveit.in/about` as "URL is on Google". Recrawl/indexing was requested again after adding `SCRAVEIT Pvt Ltd` alias signals.
- The homepage and About page now clearly identify SCRAVEIT as a food delivery platform operated by SCRAVEIT PRIVATE LIMITED and founded by Tirumuru Balaji.

## Files Prepared

- `public/index.html`: updated homepage with canonical tags, meta tags, Open Graph, Twitter tags, Organization structured data, Person structured data, and factual SCRAVEIT company/founder copy.
- `public/about.html`: new About page with company, founder, registered office, CIN, official domains and structured data.
- `public/robots.txt`: allows crawling and points to the sitemap.
- `public/sitemap.xml`: lists the homepage and About page using `https://www.scraveit.in`.
- `public/favicon.svg` and `public/logo.svg`: crawlable logo/favicon assets.
- `public/site.webmanifest`: basic brand manifest.
- `public/404.html`: branded noindex 404 page.
- `public/google2f01b515f81fa130.html`: Google Search Console verification file. Keep this file deployed to stay verified.
- `firebase.json`: Firebase Hosting config for clean URLs, cache headers and local HTML redirects.

## Hosting Action Completed

This folder was deployed with:

```bash
firebase deploy --only hosting --project savrivo-app
```

## Preferred Canonical Domain

The prepared files use `https://www.scraveit.in/` as the canonical domain because the requested preferred domain is `www.scraveit.in`.

Firebase Hosting custom domains are configured so:

- `https://www.scraveit.in/` is the primary public URL.
- `https://scraveit.in/` redirects with HTTP 301 to `https://www.scraveit.in/`.
- `https://scraveit.com/` redirects with HTTP 301 to `https://www.scraveit.in/`.
- `https://www.scraveit.com/` redirects with HTTP 301 to `https://www.scraveit.in/`.

The package canonical tags and sitemap URLs match the live preferred domain: `https://www.scraveit.in`.

## Google Search Console Actions

Completed on 2026-09-21 using the Google account `tirumurubalu@gmail.com`:

- Verified the URL-prefix property `https://www.scraveit.in/`.
- Submitted `https://www.scraveit.in/sitemap.xml`.
- Used URL Inspection and requested indexing for:
  - `https://www.scraveit.in/`
  - `https://www.scraveit.in/about`

Recommended follow-up:

- Check Coverage/Indexing after Google recrawls.
- Optionally add a Domain property for `scraveit.in` in Search Console via DNS verification for broader reporting across all subdomains and protocols.
- Optionally verify `scraveit.com` and confirm Google sees its 301 redirect to `www.scraveit.in`.

## Google Business Profile And Official Profiles

A Google Business Profile may help if SCRAVEIT has a real customer-facing office, delivery/service area, or local operations that Google can verify. Do not create a profile with a fabricated storefront, phone number, service area or opening hours.

Recommended official profile consistency:

- Name: `SCRAVEIT`
- Legal operator: `SCRAVEIT PRIVATE LIMITED`
- Founder: `Tirumuru Balaji`
- Official website: `https://www.scraveit.in/`
- Alternate official domain: `https://www.scraveit.com/`
- Registered office: `20-4-656, Macleans Road, Revenue Ward No 20-I, Vedayapalem, Nellore, Andhra Pradesh 524004, India`
- Contact email: `tirumurubalu@gmail.com`

Use the same wording on social profiles, app listings, business directories and press pages.

## Post-Deployment Validation

After deployment, verify:

```bash
curl -I https://www.scraveit.in/
curl -I https://scraveit.in/
curl -I https://www.scraveit.com/
curl -I https://scraveit.com/
curl https://www.scraveit.in/robots.txt
curl https://www.scraveit.in/sitemap.xml
```

Expected result:

- `www.scraveit.in` returns 200.
- `scraveit.in`, `scraveit.com` and `www.scraveit.com` return 301 to `https://www.scraveit.in/`.
- `robots.txt` returns 200 and includes the sitemap.
- `sitemap.xml` returns 200 and includes the homepage and About page.

Also validate the homepage and About page with Google's Rich Results Test or Schema Markup Validator.
