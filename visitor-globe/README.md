# Visitor globe

A live 3D globe that plots the approximate locations of people who open the page, as glowing
pings. It's one small [Cloudflare Worker](https://workers.cloudflare.com/) — free tier, no servers
to run, no API keys.

Locations come from Cloudflare's edge (`request.cf`), so there's nothing extra to sign up for.
Coordinates are rounded to ~11 km and stored only as aggregate counts per area — no IP addresses,
no exact positions.

It comes in two visual forms:

- **Interactive page** (`/`) — a live, draggable WebGL globe (true 3D, real-time pings).
- **README image** (`/globe.gif`) — a pre-rendered, genuinely 3D rotating globe with the ping
  locations baked in, plus a live count badge (`/badge.json`). GitHub strips JavaScript from
  READMEs, so the GIF is how the globe appears there.

## What's here

- `src/index.js` — the Worker: serves the page, logs each visit, returns points, serves the GIF
  from KV, and exposes the live count badge.
- `scripts/build-globe.mjs` — renders the rotating 3D globe to `globe.gif`.
- `wrangler.toml` — Worker config + the KV namespace binding.
- `package.json` — `wrangler` (deploy CLI) and `gifenc` (GIF encoder).

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

## Build and publish the README globe (the GIF)

The rotating 3D globe shown in the profile README is a pre-rendered GIF stored in KV. The ping
dots are baked in at build time (rendering a raster globe per request is too heavy for the free
Worker tier), so you rebuild it whenever you want the dots refreshed:

```bash
npm run globe   # render globe.gif from the latest visitor locations, then upload it to KV
```

That's two steps under the hood — `npm run build-globe` (writes `globe.gif`) and
`npm run upload-globe` (`wrangler kv key put … --remote`). If your wrangler version rejects
`--remote`, drop that flag from the `upload-globe` script.

`globe.gif` is git-ignored; it lives in KV, not the repo. Until you first publish it, `/globe.gif`
falls back to a live SVG globe so the README is never broken. The count badge (`/badge.json`) is
always live.

## Last step

Point the profile README at `https://<your-worker-url>/globe.gif` (image) and
`https://<your-worker-url>/badge.json` (count badge) — already wired up for this account.
