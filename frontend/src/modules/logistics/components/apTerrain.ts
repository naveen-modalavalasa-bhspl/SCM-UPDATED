import { AP_HOLES, AP_OUTLINE, decodePolyline, inRing, toWorld } from "./apGeo";

/**
 * The base map's layers, decoded once into world space — pure, no DOM.
 *
 * `apMapData.ts` ships every line as an encoded polyline and the relief as a byte
 * grid; this turns them into typed arrays the canvas can walk twenty thousand
 * vertices of per frame without allocating. Heights are kept in METRES on every
 * vertex, not in world km, because how tall the relief is drawn is a camera choice
 * (the Relief layer rises and flattens), not a property of the data.
 */

export interface ApMapData {
  islands: string[];
  coast: string[];
  landBorder: string[];
  districts: { name: string; full: string; label: [number, number]; rings: string[]; area_km2: number }[];
  districtBorders: string[];
  neighbours: { name: string; rings: string[]; label: [number, number] | null }[];
  seaRings: { km: number; lines: string[] }[];
  rivers: { name: string; rank: number; km: number; lines: string[] }[];
  lakes: { name: string; rings: string[]; label: [number, number] }[];
  dem: { lat0: number; lon0: number; step: number; rows: number; cols: number; unit: number; data: string };
  contours: { m: number; lines: string[] }[];
  cities: [string, number, number, number, string][];
  context: [string, number, number][];
}

/** A line in world km with its ground height, metres, on every vertex. */
export interface WorldLine {
  x: Float32Array;
  y: Float32Array;
  e: Float32Array;
}

export interface Terrain {
  rows: number;
  cols: number;
  lat0: number;
  lon0: number;
  step: number;
  /** Metres, per grid vertex; 0 where there is no data. */
  elev: Float32Array;
  /** 1 where the vertex carries data (the state, and a cell's width around it). */
  valid: Uint8Array;
  wx: Float32Array;
  wy: Float32Array;
  /** Colour of cell (r, c) at r * (cols - 1) + c, as an index into `palette`; 0 = not
   *  drawn. Quantised (40 m of height x 7% of light) so the canvas can fill every
   *  cell of one colour in one call — per-cell fills were most of a frame. */
  cellColor: Uint16Array;
  palette: string[];
  /** Unquantised colour at each grid vertex (r, g, b per vertex) — the average of the
   *  cells around it — so a close camera can blend across a cell instead of showing
   *  it as one flat tile. */
  vertexColor: Float32Array;
}

export interface District {
  name: string;
  full: string;
  areaKm2: number;
  label: { lat: number; lon: number };
  rings: [number, number][][];
  world: WorldLine[];
  box: [number, number, number, number];
}

export interface MapLayers {
  terrain: Terrain;
  outlineElev: Float32Array;
  /** Per outline edge i → i + 1: does it face the sea. */
  coastEdge: Uint8Array;
  holes: WorldLine[];
  islands: WorldLine[];
  coast: WorldLine[];
  landBorder: WorldLine[];
  districts: District[];
  districtBorders: WorldLine[];
  neighbours: { name: string; rings: WorldLine[]; label: { lat: number; lon: number } | null }[];
  seaRings: { km: number; lines: WorldLine[] }[];
  rivers: { name: string; rank: number; lines: WorldLine[]; label: { lat: number; lon: number } | null }[];
  lakes: { name: string; rings: WorldLine[]; label: { lat: number; lon: number } }[];
  contours: { m: number; lines: WorldLine[] }[];
  cities: { name: string; lat: number; lon: number; rank: number; kind: string }[];
  context: { name: string; lat: number; lon: number }[];
}

/** Hypsometric ramp for a night map: coastal plain navy up to the Ghats' ice blue. */
const RAMP: [number, [number, number, number]][] = [
  [0, [17, 33, 58]],
  [60, [19, 38, 65]],
  [200, [23, 46, 77]],
  [400, [29, 57, 91]],
  [650, [37, 71, 107]],
  [900, [50, 89, 127]],
  [1200, [76, 118, 156]],
];

export function rampColor(metres: number): [number, number, number] {
  if (metres <= RAMP[0][0]) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i += 1) {
    const [m1, c1] = RAMP[i];
    const [m0, c0] = RAMP[i - 1];
    if (metres <= m1) {
      const t = (metres - m0) / (m1 - m0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

function decodeBytes(base64: string): Uint8Array {
  const text = atob(base64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}

export function buildTerrain(dem: ApMapData["dem"]): Terrain {
  const { rows, cols, lat0, lon0, step, unit } = dem;
  const bytes = decodeBytes(dem.data);
  const n = rows * cols;
  const elev = new Float32Array(n);
  const valid = new Uint8Array(n);
  const wx = new Float32Array(n);
  const wy = new Float32Array(n);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      const b = bytes[i];
      valid[i] = b === 255 ? 0 : 1;
      elev[i] = b === 255 ? 0 : b * unit;
      const [x, y] = toWorld(lat0 + r * step, lon0 + c * step);
      wx[i] = x;
      wy[i] = y;
    }
  }
  // Hillshade, lit from the north-west at 40° like the slab's walls. The slope is
  // exaggerated for SHADING only (x14) — a 1,000 m ridge over 20 km is a 3° slope and
  // would read as flat — so the drawn height stays a separate, honest choice.
  const kmPerCellX = step * 111.32 * Math.cos((15.9 * Math.PI) / 180);
  const kmPerCellY = step * 111.32;
  const alt = (40 * Math.PI) / 180;
  const [lx, ly, lz] = [-Math.cos(alt) * Math.SQRT1_2, Math.cos(alt) * Math.SQRT1_2, Math.sin(alt)];
  const at = (r: number, c: number) =>
    elev[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
  const R = rows - 1;
  const C = cols - 1;
  const cellElev = new Float32Array(R * C);
  const cellLit = new Float32Array(R * C);
  const drawn = new Uint8Array(R * C);
  for (let r = 0; r < R; r += 1) {
    for (let c = 0; c < C; c += 1) {
      const i = r * cols + c;
      if (!valid[i] || !valid[i + 1] || !valid[i + cols] || !valid[i + cols + 1]) continue;
      const j = r * C + c;
      drawn[j] = 1;
      cellElev[j] = (elev[i] + elev[i + 1] + elev[i + cols] + elev[i + cols + 1]) / 4;
      const dzdx = ((at(r, c + 1) + at(r + 1, c + 1)) - (at(r, c - 1) + at(r + 1, c - 1))) / (4 * kmPerCellX * 1000) * 14;
      const dzdy = ((at(r + 1, c) + at(r + 1, c + 1)) - (at(r - 1, c) + at(r - 1, c + 1))) / (4 * kmPerCellY * 1000) * 14;
      const len = Math.hypot(dzdx, dzdy, 1);
      cellLit[j] = Math.max(0, (-dzdx * lx - dzdy * ly + lz) / len) / lz;
    }
  }
  // The light is softened over a cell's neighbours before it is quantised: a normal
  // taken from one six-kilometre cell is noisy, and that noise is what read as blocks
  // on the Ghats once the camera came in.
  const soft = new Float32Array(R * C);
  for (let r = 0; r < R; r += 1) {
    for (let c = 0; c < C; c += 1) {
      const j = r * C + c;
      if (!drawn[j]) continue;
      let sum = 0;
      let weight = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= R || cc >= C || !drawn[rr * C + cc]) continue;
          const w = dr === 0 && dc === 0 ? 4 : dr === 0 || dc === 0 ? 2 : 1;
          sum += cellLit[rr * C + cc] * w;
          weight += w;
        }
      }
      soft[j] = sum / weight;
    }
  }
  const shadeOf = (metres: number, lit: number): [number, number, number] => {
    const [cr, cg, cb] = rampColor(metres);
    const f = 0.48 + 0.6 * lit;
    // A touch of emission on the high ground so ridgelines glow in the night palette.
    const glow = Math.max(0, (metres - 500) / 900) * 8;
    return [Math.min(255, cr * f + glow * 0.4), Math.min(255, cg * f + glow * 0.8), Math.min(255, cb * f + glow)];
  };
  const vertexColor = new Float32Array(rows * cols * 3);
  const vertexWeight = new Float32Array(rows * cols);
  for (let r = 0; r < R; r += 1) {
    for (let c = 0; c < C; c += 1) {
      const j = r * C + c;
      if (!drawn[j]) continue;
      const rgb = shadeOf(cellElev[j], soft[j]);
      for (const v of [r * cols + c, r * cols + c + 1, (r + 1) * cols + c, (r + 1) * cols + c + 1]) {
        vertexColor[v * 3] += rgb[0];
        vertexColor[v * 3 + 1] += rgb[1];
        vertexColor[v * 3 + 2] += rgb[2];
        vertexWeight[v] += 1;
      }
    }
  }
  for (let v = 0; v < rows * cols; v += 1) {
    if (!vertexWeight[v]) continue;
    vertexColor[v * 3] /= vertexWeight[v];
    vertexColor[v * 3 + 1] /= vertexWeight[v];
    vertexColor[v * 3 + 2] /= vertexWeight[v];
  }
  const cellColor = new Uint16Array(R * C);
  const palette: string[] = [""];
  const paletteIndex = new Map<number, number>();
  const E_STEP = 40;
  const L_STEP = 0.07;
  for (let j = 0; j < R * C; j += 1) {
    if (!drawn[j]) continue;
    const eBin = Math.min(36, Math.round(cellElev[j] / E_STEP));
    const lBin = Math.min(24, Math.round(soft[j] / L_STEP));
    const key = eBin * 32 + lBin;
    let index = paletteIndex.get(key);
    if (index === undefined) {
      const [pr, pg, pb] = shadeOf(eBin * E_STEP, lBin * L_STEP);
      palette.push(`rgb(${Math.round(pr)},${Math.round(pg)},${Math.round(pb)})`);
      index = palette.length - 1;
      paletteIndex.set(key, index);
    }
    cellColor[j] = index;
  }
  return { rows, cols, lat0, lon0, step, elev, valid, wx, wy, cellColor, palette, vertexColor };
}

/** Bilinear ground height, metres. Outside the grid, or off the land, 0. */
export function elevationAt(t: Terrain, lat: number, lon: number): number {
  const fr = (lat - t.lat0) / t.step;
  const fc = (lon - t.lon0) / t.step;
  if (fr < 0 || fc < 0 || fr >= t.rows - 1 || fc >= t.cols - 1) return 0;
  const r = Math.floor(fr);
  const c = Math.floor(fc);
  const dr = fr - r;
  const dc = fc - c;
  const i = r * t.cols + c;
  const e = t.elev;
  return (e[i] * (1 - dc) + e[i + 1] * dc) * (1 - dr) + (e[i + t.cols] * (1 - dc) + e[i + t.cols + 1] * dc) * dr;
}

function worldLine(points: [number, number][], terrain: Terrain | null): WorldLine {
  const x = new Float32Array(points.length);
  const y = new Float32Array(points.length);
  const e = new Float32Array(points.length);
  points.forEach(([lat, lon], i) => {
    const [wx, wy] = toWorld(lat, lon);
    x[i] = wx;
    y[i] = wy;
    e[i] = terrain ? elevationAt(terrain, lat, lon) : 0;
  });
  return { x, y, e };
}

const ll = ([lat, lon]: [number, number]) => ({ lat, lon });

export function buildLayers(data: ApMapData): MapLayers {
  const terrain = buildTerrain(data.dem);
  const onGround = (text: string) => worldLine(decodePolyline(text), terrain);
  const atSea = (text: string) => worldLine(decodePolyline(text), null);

  const outlineElev = new Float32Array(AP_OUTLINE.length);
  AP_OUTLINE.forEach(([lat, lon], i) => { outlineElev[i] = elevationAt(terrain, lat, lon); });
  // The coast runs were cut from the same ring the outline was, so a vertex on the
  // coast matches exactly at the encoding's precision.
  const key = (lat: number, lon: number) => `${Math.round(lat * 1e4)},${Math.round(lon * 1e4)}`;
  const coastKeys = new Set<string>();
  for (const run of data.coast) for (const [lat, lon] of decodePolyline(run)) coastKeys.add(key(lat, lon));
  const coastEdge = new Uint8Array(AP_OUTLINE.length);
  for (let i = 0; i < AP_OUTLINE.length - 1; i += 1) {
    coastEdge[i] = coastKeys.has(key(...AP_OUTLINE[i])) && coastKeys.has(key(...AP_OUTLINE[i + 1])) ? 1 : 0;
  }

  const districts: District[] = data.districts.map((d) => {
    const rings = d.rings.map((ring) => decodePolyline(ring));
    let [s, w, n, e] = [90, 180, -90, -180];
    for (const ring of rings) for (const [lat, lon] of ring) {
      s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
    }
    return {
      name: d.name, full: d.full, areaKm2: d.area_km2, label: ll(d.label), rings,
      world: rings.map((ring) => worldLine(ring, terrain)), box: [s, w, n, e],
    };
  });

  return {
    terrain,
    outlineElev,
    coastEdge,
    holes: AP_HOLES.map((ring) => worldLine(ring, terrain)),
    islands: data.islands.map(onGround),
    coast: data.coast.map(onGround),
    landBorder: data.landBorder.map(onGround),
    districts,
    districtBorders: data.districtBorders.map(onGround),
    neighbours: data.neighbours.map((n) => ({ name: n.name, rings: n.rings.map(atSea), label: n.label ? ll(n.label) : null })),
    seaRings: data.seaRings.map((r) => ({ km: r.km, lines: r.lines.map(atSea) })),
    rivers: data.rivers.map((r) => {
      const lines = r.lines.map(onGround);
      // Label a river at the middle of its longest reach, where it is plainly that river.
      const longest = r.lines.map((text) => decodePolyline(text)).sort((a, b) => b.length - a.length)[0];
      const mid = longest?.[Math.floor(longest.length / 2)];
      return { name: r.name, rank: r.rank, lines, label: mid ? ll(mid) : null };
    }),
    lakes: data.lakes.map((l) => ({ name: l.name, rings: l.rings.map(onGround), label: ll(l.label) })),
    contours: data.contours.map((c) => ({ m: c.m, lines: c.lines.map((text) => {
      const line = onGround(text);
      line.e.fill(c.m); // A contour is at its level by definition, not at the sampled ground.
      return line;
    }) })),
    cities: data.cities.map(([name, lat, lon, rank, kind]) => ({ name, lat, lon, rank, kind })),
    context: data.context.map(([name, lat, lon]) => ({ name, lat, lon })),
  };
}

/** The district a point falls in, or null (outside the state, or in Yanam). */
export function districtAt(layers: MapLayers, lat: number, lon: number): District | null {
  for (const d of layers.districts) {
    const [s, w, n, e] = d.box;
    if (lat < s || lat > n || lon < w || lon > e) continue;
    if (d.rings.some((ring) => inRing(ring, lat, lon))) return d;
  }
  return null;
}

/** A scale bar that reads in round numbers: the largest 1/2/5 × 10ⁿ km under `maxPx`. */
export function niceScale(pxPerKm: number, maxPx = 120): { km: number; px: number } {
  if (!(pxPerKm > 0)) return { km: 0, px: 0 };
  const raw = maxPx / pxPerKm;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const km = [5, 2, 1].map((m) => m * pow).find((v) => v <= raw) ?? pow;
  return { km, px: km * pxPerKm };
}

export function formatLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"} · ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
}

let loading: Promise<MapLayers> | null = null;
/** The base map, loaded and decoded once per session however many maps are drawn. */
export function loadMapLayers(): Promise<MapLayers> {
  loading ??= import("./apMapData").then((m) => buildLayers(m.AP_MAP_DATA)).catch((error) => {
    loading = null; // A failed chunk load (a deploy mid-session) must be retryable.
    throw error;
  });
  return loading;
}
