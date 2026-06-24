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
    if (url.pathname === "/globe.svg" && request.method === "GET") {
      return renderGlobe(env);
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

// ---------------------------------------------------------------------------
// Globe image (/globe.svg)
//
// Draws an orthographic 3D globe with continent outlines and a glowing ping for
// every place a visitor has opened the page. Rendered as an SVG so it can be
// embedded directly in a GitHub README (which strips JS but allows images).
// ---------------------------------------------------------------------------

const LAND_KEY = "land-geojson";
// Low-res world land outlines (~110m). Cached in KV after the first fetch.
const LAND_URL =
  "https://cdn.jsdelivr.net/gh/martynafford/natural-earth-geojson@master/110m/physical/ne_110m_land.json";

const SIZE = 440; // viewBox px
const R = 200; // globe radius
const CX = SIZE / 2;
const CY = SIZE / 2;
const D2R = Math.PI / 180;

async function renderGlobe(env) {
  const [land, points] = await Promise.all([getLand(env), readPoints(env)]);
  const svg = buildGlobeSvg(land, Object.values(points));
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Let GitHub's image proxy refresh it every few minutes.
      "cache-control": "public, max-age=300",
    },
  });
}

async function getLand(env) {
  let raw = await env.VISITORS.get(LAND_KEY);
  if (!raw) {
    try {
      const res = await fetch(LAND_URL, { cf: { cacheTtl: 86400 } });
      if (res.ok) {
        raw = await res.text();
        await env.VISITORS.put(LAND_KEY, raw);
      }
    } catch {
      /* network hiccup — globe just renders without continents this time */
    }
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Orthographic projection. Returns [x, y] on screen, or null if the point is on
// the far side of the globe (hidden behind it).
function project(lonDeg, latDeg, lon0, lat0) {
  const lon = lonDeg * D2R;
  const lat = latDeg * D2R;
  const l0 = lon0 * D2R;
  const p0 = lat0 * D2R;
  const cosc =
    Math.sin(p0) * Math.sin(lat) +
    Math.cos(p0) * Math.cos(lat) * Math.cos(lon - l0);
  if (cosc < 0) return null;
  const x = R * Math.cos(lat) * Math.sin(lon - l0);
  const y =
    R * (Math.cos(p0) * Math.sin(lat) - Math.sin(p0) * Math.cos(lat) * Math.cos(lon - l0));
  return [CX + x, CY - y];
}

// Run a callback over every coordinate ring in a GeoJSON land file.
function eachRing(geo, cb) {
  if (!geo) return;
  const feats = geo.type === "FeatureCollection" ? geo.features : [geo];
  for (const f of feats) {
    const g = f.geometry || f;
    if (!g) continue;
    if (g.type === "Polygon") {
      for (const ring of g.coordinates) cb(ring);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates) for (const ring of poly) cb(ring);
    }
  }
}

const FRAMES = 24; // rotation steps (more = smoother, larger file)
const SPIN = 22; // seconds for one full rotation
const TILT = 18; // fixed north-ward tilt of the globe's axis

// Continent outlines for one viewing angle, split where rings cross to the far
// side. Coordinates are rounded and decimated to keep each frame small.
function frameLand(land, lon0) {
  let d = "";
  eachRing(land, (ring) => {
    let drawing = false, px = 0, py = 0;
    for (const [lon, lat] of ring) {
      const p = project(lon, lat, lon0, TILT);
      if (p) {
        const x = p[0], y = p[1];
        if (drawing && Math.abs(x - px) < 1 && Math.abs(y - py) < 1) continue;
        d += (drawing ? "L" : "M") + Math.round(x) + " " + Math.round(y) + " ";
        drawing = true; px = x; py = y;
      } else {
        drawing = false;
      }
    }
  });
  return d;
}

// Glowing pings for one viewing angle (hidden ones, on the far side, dropped).
function framePings(points, lon0) {
  return points
    .map((p) => ({ p, xy: project(p.lng, p.lat, lon0, TILT) }))
    .filter((d) => d.xy)
    .sort((a, b) => (a.p.count || 1) - (b.p.count || 1))
    .map(({ p, xy }) => {
      const r = Math.min(2.2 + Math.log10((p.count || 1) + 1) * 2.4, 7);
      const x = Math.round(xy[0]), y = Math.round(xy[1]);
      return (
        `<circle cx="${x}" cy="${y}" r="${(r * 2.4).toFixed(1)}" fill="#74c7ec" opacity="0.18"/>` +
        `<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="#9fe0ff"/>`
      );
    })
    .join("");
}

// A rotating globe: one pre-projected frame per angle, flipped through with SMIL
// so the planet appears to spin. Animation runs even when embedded as an image.
function buildGlobeSvg(land, points) {
  let frames = "";
  for (let i = 0; i < FRAMES; i++) {
    const lon0 = (i * 360) / FRAMES;
    const begin = ((i * SPIN) / FRAMES).toFixed(2);
    frames +=
      `<g opacity="0">` +
      `<animate attributeName="opacity" begin="${begin}s" dur="${SPIN}s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;${(1 / FRAMES).toFixed(4)};1" values="1;0;0"/>` +
      `<path d="${frameLand(land, lon0)}" fill="none" stroke="#3f7fb3" stroke-width="0.9" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>` +
      framePings(points, lon0) +
      `</g>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Rotating globe of where people read this from">
<defs>
<radialGradient id="ocean" cx="38%" cy="34%" r="75%">
<stop offset="0%" stop-color="#10243a"/>
<stop offset="65%" stop-color="#0a1626"/>
<stop offset="100%" stop-color="#05060a"/>
</radialGradient>
<radialGradient id="halo" cx="50%" cy="50%" r="50%">
<stop offset="78%" stop-color="#74c7ec" stop-opacity="0"/>
<stop offset="100%" stop-color="#74c7ec" stop-opacity="0.22"/>
</radialGradient>
</defs>
<circle cx="${CX}" cy="${CY}" r="${R + 14}" fill="url(#halo)"/>
<circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#ocean)" stroke="#1f3a5c" stroke-width="1"/>
${frames}
</svg>`;
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
