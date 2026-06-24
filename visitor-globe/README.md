# Visitor globe

A live 3D globe that plots the approximate locations of people who open the page, as glowing
pings. It's one small [Cloudflare Worker](https://workers.cloudflare.com/) — free tier, no servers
to run, no API keys.

Locations come from Cloudflare's edge (`request.cf`), so there's nothing extra to sign up for.
Coordinates are rounded to ~11 km and stored only as aggregate counts per area — no IP addresses,
no exact positions.

## What's here

- `src/index.js` — the whole thing: serves the page, logs each visit, returns the points.
- `wrangler.toml` — Worker config + the KV namespace binding.
- `package.json` — pulls in `wrangler` (the deploy CLI).

## Deploy (about 5 minutes, all free)

You'll need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and
[Node.js](https://nodejs.org/) installed.

```bash
cd visitor-globe
npm install

# 1. Log in to Cloudflare (opens a browser once).
npx wrangler login

# 2. Create the storage and copy the printed id into wrangler.toml
#    (replace REPLACE_WITH_YOUR_KV_NAMESPACE_ID).
npx wrangler kv namespace create VISITORS

# 3. Ship it.
npx wrangler deploy
```

`wrangler deploy` prints your live URL, e.g. `https://visitor-globe.<your-subdomain>.workers.dev`.

## Try it locally first (optional)

```bash
npx wrangler dev
```

Note: in local dev Cloudflare usually can't resolve a location, so the globe will be empty until
it's deployed and real visitors hit the edge. That's expected.

## Last step

Put your live URL in the main profile README — replace the "link coming once it's up" line with a
link to the globe.
