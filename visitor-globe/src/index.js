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
    if (url.pathname === "/globe.gif" && request.method === "GET") {
      return serveGif(env);
    }
    if (url.pathname === "/badge.json" && request.method === "GET") {
      return badge(env);
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

// Serves the pre-rendered 3D globe GIF (built by scripts/build-globe.mjs and
// uploaded to KV). Falls back to the live SVG until the GIF has been published.
async function serveGif(env) {
  const buf = await env.VISITORS.get("globe-gif", { type: "arrayBuffer" });
  if (!buf) return renderGlobe(env);
  return new Response(buf, {
    headers: {
      "content-type": "image/gif",
      "cache-control": "public, max-age=300",
    },
  });
}

// A live shields.io endpoint badge: "<visits> from <places> places".
async function badge(env) {
  const pts = Object.values(await readPoints(env));
  const visits = pts.reduce((s, p) => s + (p.count || 1), 0);
  const places = pts.length;
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      label: "visitors",
      message: places ? `${visits} from ${places} places` : "be the first",
      color: "0e7490",
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
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

const SPIN = 26; // seconds for one full, continuous rotation

// A smoothly rotating globe. Continents are drawn once on a wrapped
// equirectangular strip and panned continuously behind a circular mask — far
// more fluid than flipping through discrete frames, and a smaller file too.
// Limb shading plus a soft highlight give it the depth of a real sphere. The
// animation runs even when the SVG is embedded as an image (e.g. a README).
function buildGlobeSvg(land, points) {
  const MAPW = 4 * R; // a full 360° of longitude at the globe's scale
  const MAPH = 2 * R; // 180° of latitude == the globe's diameter
  const BOX = CX - R; // top-left corner of the globe's bounding box

  const ex = (lon) => ((lon + 180) / 360) * MAPW;
  const ey = (lat) => ((90 - lat) / 180) * MAPH;

  // Continent outlines in map coordinates (drawn once). Break the path wherever
  // a ring jumps across the antimeridian so it doesn't streak across the map.
  let landPath = "";
  eachRing(land, (ring) => {
    let drawing = false, prevLon = null;
    for (const [lon, lat] of ring) {
      if (prevLon !== null && Math.abs(lon - prevLon) > 180) drawing = false;
      landPath += (drawing ? "L" : "M") + ex(lon).toFixed(1) + " " + ey(lat).toFixed(1) + " ";
      drawing = true;
      prevLon = lon;
    }
  });

  // Glowing, gently pulsing pings at each visitor location.
  const pings = points
    .map((p) => {
      const r = Math.min(2.2 + Math.log10((p.count || 1) + 1) * 2.4, 7);
      const x = ex(p.lng).toFixed(1), y = ey(p.lat).toFixed(1);
      return (
        `<circle cx="${x}" cy="${y}" r="${(r * 2.4).toFixed(1)}" fill="#74c7ec" opacity="0.18"/>` +
        `<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="#9fe0ff">` +
        `<animate attributeName="opacity" values="0.55;1;0.55" dur="3s" repeatCount="indefinite"/>` +
        `</circle>`
      );
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Rotating globe of where people read this from">
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
<radialGradient id="limb" cx="50%" cy="50%" r="50%">
<stop offset="55%" stop-color="#03040a" stop-opacity="0"/>
<stop offset="100%" stop-color="#03040a" stop-opacity="0.72"/>
</radialGradient>
<radialGradient id="spec" cx="50%" cy="50%" r="50%">
<stop offset="0%" stop-color="#cdeaff" stop-opacity="0.22"/>
<stop offset="100%" stop-color="#cdeaff" stop-opacity="0"/>
</radialGradient>
<clipPath id="globeClip"><circle cx="${CX}" cy="${CY}" r="${R}"/></clipPath>
</defs>
<circle cx="${CX}" cy="${CY}" r="${R + 14}" fill="url(#halo)"/>
<circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#ocean)"/>
<g clip-path="url(#globeClip)">
<g transform="translate(${BOX} ${BOX})">
<g>
<animateTransform attributeName="transform" type="translate" from="0 0" to="-${MAPW} 0" dur="${SPIN}s" repeatCount="indefinite"/>
<g id="world">
<path d="${landPath}" fill="none" stroke="#3f7fb3" stroke-width="0.9" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>
${pings}
</g>
<use xlink:href="#world" href="#world" x="${MAPW}"/>
</g>
</g>
</g>
<ellipse cx="${CX - 58}" cy="${CY - 66}" rx="120" ry="100" fill="url(#spec)" clip-path="url(#globeClip)"/>
<circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#limb)"/>
<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#24507a" stroke-width="1"/>
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
