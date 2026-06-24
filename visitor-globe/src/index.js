// Visitor globe — a single Cloudflare Worker that:
//   1. serves the globe page,
//   2. logs the approximate location of each visitor (from Cloudflare's edge data),
//   3. returns all logged locations so the page can plot them as pings.
//
// Privacy: coordinates are rounded to ~11 km before they are ever stored, and only
// aggregate counts per area are kept — no IP addresses, no exact positions.

const KV_KEY = "points";
const MAX_AREAS = 5000; // safety cap on distinct areas stored

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/track" && request.method === "POST") {
      return trackVisit(request, env);
    }
    if (url.pathname === "/api/points" && request.method === "GET") {
      return listPoints(env);
    }
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

async function trackVisit(request, env) {
  const cf = request.cf || {};
  const lat = Number(cf.latitude);
  const lng = Number(cf.longitude);

  // Cloudflare can't always resolve a location (e.g. local dev). Skip silently.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ ok: true, located: false });
  }

  // Round to 1 decimal (~11 km) so we never store a precise position.
  const rLat = Math.round(lat * 10) / 10;
  const rLng = Math.round(lng * 10) / 10;
  const key = `${rLat},${rLng}`;

  const points = await readPoints(env);
  const existing = points[key];
  if (existing) {
    existing.count += 1;
    existing.last = Date.now();
  } else if (Object.keys(points).length < MAX_AREAS) {
    points[key] = {
      lat: rLat,
      lng: rLng,
      city: cf.city || "",
      country: cf.country || "",
      count: 1,
      last: Date.now(),
    };
  }

  await env.VISITORS.put(KV_KEY, JSON.stringify(points));
  return json({ ok: true, located: true });
}

async function listPoints(env) {
  const points = await readPoints(env);
  return json(Object.values(points));
}

async function readPoints(env) {
  const raw = await env.VISITORS.get(KV_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function json(body) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Where you're reading from</title>
<style>
  html, body { margin: 0; height: 100%; background: #05060a; color: #cdd6f4;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  #globe { position: fixed; inset: 0; }
  .overlay { position: fixed; left: 24px; top: 20px; z-index: 2; max-width: 320px; }
  .overlay h1 { font-size: 20px; margin: 0 0 6px; font-weight: 600; }
  .overlay p { margin: 0; font-size: 13px; line-height: 1.5; color: #8b93b8; }
  .count { color: #74c7ec; font-weight: 600; }
  .credit { position: fixed; right: 16px; bottom: 12px; z-index: 2; font-size: 11px; color: #4b5170; }
  .credit a { color: #6c7293; }
</style>
</head>
<body>
<div id="globe"></div>
<div class="overlay">
  <h1>Where you're reading from</h1>
  <p>Each ping is roughly where someone opened this page. Locations are approximate
     (rounded to ~11 km) and anonymous. <span class="count" id="count"></span></p>
</div>
<div class="credit">approximate &amp; anonymous · powered by Cloudflare edge</div>

<script src="https://unpkg.com/globe.gl"></script>
<script>
  const world = Globe()(document.getElementById('globe'))
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
    .backgroundColor('#05060a')
    .pointAltitude(0.01)
    .pointRadius(d => Math.min(0.2 + Math.log10(d.count + 1) * 0.25, 1.0))
    .pointColor(() => '#74c7ec')
    .pointLabel(d => {
      const place = [d.city, d.country].filter(Boolean).join(', ') || 'Somewhere';
      return place + ' — ' + d.count + (d.count === 1 ? ' visit' : ' visits');
    });

  // Gentle auto-rotation.
  world.controls().autoRotate = true;
  world.controls().autoRotateSpeed = 0.6;

  function fit() { world.width(window.innerWidth).height(window.innerHeight); }
  window.addEventListener('resize', fit);
  fit();

  async function refresh() {
    try {
      const res = await fetch('/api/points');
      const points = await res.json();
      world.pointsData(points);
      const total = points.reduce((s, p) => s + p.count, 0);
      document.getElementById('count').textContent =
        total > 0 ? total + (total === 1 ? ' visit so far.' : ' visits so far.') : '';
    } catch (e) { /* ignore */ }
  }

  // Log this visit, then draw everyone (including this one).
  fetch('/api/track', { method: 'POST' }).finally(refresh);
  setInterval(refresh, 30000);
</script>
</body>
</html>`;
