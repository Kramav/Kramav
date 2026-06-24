// Renders the rotating 3D globe to an animated GIF, with a glowing dot at each
// visitor location, and writes it to ../globe.gif.
//
// Unlike the live SVG, a GIF can't be regenerated cheaply on every request, so
// the ping dots are baked in at build time. Run `npm run globe` to rebuild with
// the latest visitor locations and upload the result. The live count badge
// (/badge.json) always reflects the current total regardless.
//
// Usage:
//   node scripts/build-globe.mjs              (pulls live pings from the Worker)
//   GLOBE_BASE_URL=http://localhost:8787 node scripts/build-globe.mjs

import gifenc from "gifenc";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const LAND_URL =
  "https://cdn.jsdelivr.net/gh/martynafford/natural-earth-geojson@master/110m/physical/ne_110m_land.json";
const BASE = process.env.GLOBE_BASE_URL || "https://visitor-globe.kramerp28.workers.dev";

// Render settings.
const S = 340;       // image size (px)
const FRAMES = 48;   // rotation steps
const DELAY = 60;    // ms per frame (FRAMES * DELAY = seconds per rotation)
const TILT = 23;     // axial tilt toward the viewer
const MW = 720, MH = 360; // land mask resolution (0.5°)
const D2R = Math.PI / 180;

// --- land/sea mask from GeoJSON (point-in-polygon, even-odd for lakes) ---
function ringsOf(geo) {
  const polys = [];
  for (const f of geo.features) {
    const g = f.geometry; if (!g) continue;
    if (g.type === "Polygon") polys.push(g.coordinates);
    else if (g.type === "MultiPolygon") for (const p of g.coordinates) polys.push(p);
  }
  return polys;
}
function inPoly(rings, x, y) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y)) {
        const xint = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (x < xint) inside = !inside;
      }
    }
  }
  return inside;
}
function buildMask(geo) {
  const polys = ringsOf(geo);
  const bb = polys.map((rs) => {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const r of rs) for (const [x, y] of r) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    return [a, b, c, d];
  });
  const m = new Uint8Array(MW * MH);
  for (let my = 0; my < MH; my++) {
    const lat = 90 - (my + 0.5) * (180 / MH);
    for (let mx = 0; mx < MW; mx++) {
      const lon = -180 + (mx + 0.5) * (360 / MW);
      let land = false;
      for (let p = 0; p < polys.length; p++) {
        const q = bb[p];
        if (lon < q[0] || lon > q[2] || lat < q[1] || lat > q[3]) continue;
        if (inPoly(polys[p], lon, lat)) { land = true; break; }
      }
      m[my * MW + mx] = land ? 1 : 0;
    }
  }
  return m;
}

function nrm(v) { const m = Math.hypot(v[0], v[1], v[2]); return [v[0] / m, v[1] / m, v[2] / m]; }

// --- render one orthographic (true 3D) frame to RGBA ---
function renderFrame(mask, lon0, pings) {
  const R = S / 2 - 5, cx = S / 2, cy = S / 2;
  const img = new Uint8Array(S * S * 4);
  const light = nrm([-0.5, 0.6, 0.75]);
  const f1 = TILT * D2R;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const x = (px - cx) / R, y = -(py - cy) / R, rho2 = x * x + y * y;
      if (rho2 > 1) continue; // outside the sphere -> transparent
      const z = Math.sqrt(1 - rho2);
      const lat = Math.asin(z * Math.sin(f1) + y * Math.cos(f1));
      const lon = lon0 * D2R + Math.atan2(x, z * Math.cos(f1) - y * Math.sin(f1));
      const lonDeg = ((lon / D2R) % 360 + 540) % 360 - 180, latDeg = lat / D2R;
      const mx = Math.min(MW - 1, Math.max(0, ((lonDeg + 180) / 360) * MW | 0));
      const my = Math.min(MH - 1, Math.max(0, ((90 - latDeg) / 180) * MH | 0));
      const land = mask[my * MW + mx];
      const diff = Math.max(0, x * light[0] + y * light[1] + z * light[2]);
      const sh = 0.18 + 0.82 * diff, limb = 0.55 + 0.45 * z;
      const dither = Math.random() * 4 - 2; // breaks up GIF colour banding
      let r, g, b;
      if (land) { r = 60; g = 150; b = 120; } else { r = 18; g = 40; b = 70; }
      r = r * sh * limb + dither; g = g * sh * limb + dither; b = b * sh * limb + dither;
      const o = (py * S + px) * 4;
      img[o] = Math.max(0, Math.min(255, r));
      img[o + 1] = Math.max(0, Math.min(255, g));
      img[o + 2] = Math.max(0, Math.min(255, b));
      img[o + 3] = 255;
    }
  }
  // pings on the near-facing hemisphere
  for (const p of pings) {
    const la = p.lat * D2R, lo = p.lng * D2R;
    const gx = Math.cos(la) * Math.sin(lo - lon0 * D2R);
    const gyy = Math.sin(la);
    const gz = Math.cos(la) * Math.cos(lo - lon0 * D2R);
    const vy = gyy * Math.cos(f1) - gz * Math.sin(f1);
    const vz = gyy * Math.sin(f1) + gz * Math.cos(f1);
    if (vz <= 0) continue;
    const sx = cx + gx * R, sy = cy - vy * R;
    const rad = Math.min(5 + Math.log10((p.count || 1) + 1) * 3, 9);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const d = Math.hypot(dx, dy); if (d > rad) continue;
      const ix = (sx + dx) | 0, iy = (sy + dy) | 0;
      if (ix < 0 || iy < 0 || ix >= S || iy >= S) continue;
      const a = Math.max(0, 1 - d / rad), o = (iy * S + ix) * 4;
      img[o] = Math.min(255, img[o] + 150 * a);
      img[o + 1] = Math.min(255, img[o + 1] + 220 * a);
      img[o + 2] = Math.min(255, img[o + 2] + 255 * a);
      img[o + 3] = 255;
    }
  }
  return img;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function main() {
  console.log("Fetching continent data…");
  const geo = await fetchJSON(LAND_URL);

  let pings = [];
  try {
    console.log(`Fetching visitor locations from ${BASE}/api/points …`);
    pings = await fetchJSON(`${BASE}/api/points`);
    console.log(`  ${pings.length} location(s).`);
  } catch (e) {
    console.warn(`  Couldn't fetch pings (${e.message}); rendering continents only.`);
  }

  console.log("Building land mask…");
  const mask = buildMask(geo);

  console.log(`Rendering ${FRAMES} frames…`);
  const enc = GIFEncoder();
  for (let i = 0; i < FRAMES; i++) {
    const rgba = renderFrame(mask, (i * 360) / FRAMES, pings);
    const palette = quantize(rgba, 256, { format: "rgba4444" });
    const index = applyPalette(rgba, palette, "rgba4444");
    enc.writeFrame(index, S, S, { palette, delay: DELAY, transparent: true });
  }
  enc.finish();

  const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "globe.gif");
  const bytes = Buffer.from(enc.bytes());
  writeFileSync(out, bytes);
  console.log(`Wrote ${out} (${(bytes.length / 1024).toFixed(0)} KB).`);
  console.log("Next: `npm run upload-globe` to publish it.");
}

main().catch((e) => { console.error(e); process.exit(1); });
