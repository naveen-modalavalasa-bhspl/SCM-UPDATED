import { AP_OUTLINE_WORLD, projector, toWorld, type Camera, type Projected } from "./apGeo";
import { elevationAt, type MapLayers, type WorldLine } from "./apTerrain";

/**
 * The base map of ApMap3D, painted onto a canvas — everything that does not take a
 * click: the sea, the neighbouring states, the slab of the state with its relief,
 * water, district lines, the stocking points and the place names.
 *
 * It is a canvas and not SVG because it is twenty thousand vertices redrawn on every
 * frame of an orbit; as SVG that was a string of coordinates rebuilt and re-parsed per
 * frame. What the user clicks — routes, stops, pins, the origin — stays SVG above it,
 * where it keeps its hit testing and its animation. Still plain 2D: no WebGL, no
 * tiles, no third party, and it prints.
 */

export const SLAB_KM = 10;

/** How thick the slab is drawn at this zoom. Ten kilometres reads as a solid block
 *  over the whole state and as a cliff along one district's coast, so it thins as the
 *  camera comes in — the relief on top is what should stand out close up. */
export function slabKm(zoom: number): number {
  return SLAB_KM * Math.min(1, Math.max(0.22, 1.25 / Math.max(zoom, 0.01)));
}
/** Height drawn per metre of ground at full relief: the Ghats' ~1,150 m (smoothed)
 *  stand about 21 km over the plain on a state 900 km across — about 8x. */
export const RELIEF_KM_PER_M = 0.018;

export interface LayerToggles {
  relief: boolean;
  districts: boolean;
  water: boolean;
  places: boolean;
  context: boolean;
  points: boolean;
}

export const DEFAULT_TOGGLES: LayerToggles = {
  relief: true, districts: true, water: true, places: true, context: true, points: true,
};

export const NODE_COLORS: Record<string, string> = {
  LIP: "#7dd3fc",
  MDP: "#c4b5fd",
  MAIN: "#fbbf24",
  other: "#94a3b8",
};

/** World height of a vertex whose ground is `metres` high, at this much relief. */
export function lineZ(metres: number, relief: number, slab = SLAB_KM): number {
  return slab + metres * RELIEF_KM_PER_M * relief;
}

/** Height of the ground at a point, world km, for markers that stand on it. */
export function groundZ(layers: MapLayers | null, relief: number, lat: number, lon: number, slab = SLAB_KM): number {
  if (!layers || relief <= 0) return slab;
  return slab + elevationAt(layers.terrain, lat, lon) * RELIEF_KM_PER_M * relief;
}

export interface DrawInput {
  cam: Camera;
  dpr: number;
  layers: MapLayers | null;
  show: LayerToggles;
  /** 0..1 — how far the relief has risen (it animates in and out). */
  relief: number;
  nodes: { p: Projected; kind: string }[];
  /** Screen boxes the SVG layer has already written in (the origin's and the stops'
   *  labels): place names move aside for them rather than printing underneath. */
  reserved?: [number, number, number, number][];
  /** The camera is mid-move: draw the relief coarser, it is redrawn in full once still. */
  moving?: boolean;
  /** The learned quality level while moving (`mapQuality.ts`): 2 and up leave out the
   *  contours and the scanlines, 3 also coarsens the relief a step and drops the faint
   *  river halos and dashed sea rings. Never a lower resolution. */
  level?: number;
}

type Project = (wx: number, wy: number, wz: number) => Projected;

/** +1 if the outline runs anticlockwise (its outward normal is to the right of each
 *  edge), -1 if clockwise. Worked out once from its signed area. */
const OUTLINE_TURN = (() => {
  let area = 0;
  for (let i = 0; i < AP_OUTLINE_WORLD.length - 1; i += 1) {
    const [x0, y0] = AP_OUTLINE_WORLD[i];
    const [x1, y1] = AP_OUTLINE_WORLD[i + 1];
    area += x0 * y1 - x1 * y0;
  }
  return area > 0 ? 1 : -1;
})();

const sprites = new Map<string, HTMLCanvasElement>();
/** A soft round glow, drawn once per colour and stamped for every point. */
function glowSprite(color: string): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  let sprite = sprites.get(color);
  if (!sprite) {
    sprite = document.createElement("canvas");
    sprite.width = sprite.height = 48;
    const g = sprite.getContext("2d");
    if (!g) return null;
    const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    grad.addColorStop(0, color);
    grad.addColorStop(0.25, `${color}aa`);
    grad.addColorStop(1, `${color}00`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 48, 48);
    sprites.set(color, sprite);
  }
  return sprite;
}

let scanTile: HTMLCanvasElement | null = null;
function scanPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (typeof document === "undefined") return null;
  if (!scanTile) {
    scanTile = document.createElement("canvas");
    scanTile.width = 4;
    scanTile.height = 3;
    const g = scanTile.getContext("2d");
    if (!g) return null;
    g.fillStyle = "rgba(190, 235, 255, 0.05)";
    g.fillRect(0, 0, 4, 1);
  }
  return ctx.createPattern(scanTile, "repeat");
}

/** Vertices closer than this on screen are dropped as a path is built. Over the whole
 *  state the outline's 2,635 vertices sit under a pixel apart, and it is the vertex
 *  count, not the pixel count, that a frame's paths cost to tessellate. */
const MIN_STEP_PX = 1.2;

function trace(ctx: CanvasRenderingContext2D, P: Project, line: WorldLine, z: (e: number) => number, close = false) {
  const n = line.x.length;
  let lx = 0;
  let ly = 0;
  for (let i = 0; i < n; i += 1) {
    const p = P(line.x[i], line.y[i], z(line.e[i]));
    if (i === 0) {
      ctx.moveTo(p.x, p.y);
    } else if (i === n - 1 || Math.abs(p.x - lx) + Math.abs(p.y - ly) >= MIN_STEP_PX) {
      ctx.lineTo(p.x, p.y);
    } else {
      continue;
    }
    lx = p.x;
    ly = p.y;
  }
  if (close) ctx.closePath();
}

/** The same decimation over a ring that is already projected, closed. */
function ring(ctx: CanvasRenderingContext2D, pts: Projected[], dy = 0) {
  let lx = 0;
  let ly = 0;
  pts.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y + dy);
    else if (i === pts.length - 1 || Math.abs(p.x - lx) + Math.abs(p.y - ly) >= MIN_STEP_PX) ctx.lineTo(p.x, p.y + dy);
    else return;
    lx = p.x;
    ly = p.y;
  });
  ctx.closePath();
}

function strokeLines(ctx: CanvasRenderingContext2D, P: Project, lines: WorldLine[], z: (e: number) => number) {
  ctx.beginPath();
  for (const line of lines) trace(ctx, P, line, z);
  ctx.stroke();
}

export function drawMap(ctx: CanvasRenderingContext2D, input: DrawInput) {
  const { cam, dpr, layers, show } = input;
  const level = input.moving ? input.level ?? 1 : 0;
  const { width: W, height: H } = cam;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const P = projector(cam);
  // The caller animates `relief` towards 0 when the layer is switched off, so the
  // ground sinks rather than snapping flat.
  const k = RELIEF_KM_PER_M * input.relief;
  const slab = slabKm(cam.zoom);
  const zTop = (e: number) => slab + e * k;
  const zSea = () => 0;
  const wz = Math.min(2.2, Math.max(0.7, Math.sqrt(cam.zoom)));

  // ---------------------------------------------------------------- the sea plane
  ctx.strokeStyle = "rgba(120, 170, 240, 0.055)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let lat = 10; lat <= 22; lat += 1) {
    for (let lon = 73; lon <= 89; lon += 0.5) {
      const [x, y] = toWorld(lat, lon);
      const p = P(x, y, 0);
      if (lon === 73) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
  }
  for (let lon = 74; lon <= 88; lon += 1) {
    for (let lat = 10; lat <= 22; lat += 0.5) {
      const [x, y] = toWorld(lat, lon);
      const p = P(x, y, 0);
      if (lat === 10) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
  }
  ctx.stroke();

  if (layers) {
    // Offset rings in the Bay of Bengal, fading out to sea.
    layers.seaRings.forEach((ring, index) => {
      if (level >= 3 && index >= 2) return;
      ctx.strokeStyle = `rgba(56, 189, 248, ${[0.26, 0.17, 0.11, 0.075, 0.05][index] ?? 0.04})`;
      ctx.lineWidth = index === 0 ? 1.2 : 1;
      ctx.setLineDash(index >= 2 ? [2, 7] : []);
      strokeLines(ctx, P, ring.lines, zSea);
    });
    ctx.setLineDash([]);
    if (show.context) {
      ctx.fillStyle = "rgba(15, 34, 66, 0.78)";
      ctx.strokeStyle = "rgba(120, 156, 214, 0.26)";
      ctx.lineWidth = 0.8;
      for (const n of layers.neighbours) {
        ctx.beginPath();
        for (const ring of n.rings) trace(ctx, P, ring, zSea, true);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------- the slab
  const n = AP_OUTLINE_WORLD.length;
  const top: Projected[] = new Array(n);
  const bottom: Projected[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const [x, y] = AP_OUTLINE_WORLD[i];
    top[i] = P(x, y, zTop(layers ? layers.outlineElev[i] : 0));
    bottom[i] = P(x, y, 0);
  }

  // Its shadow on the sea: the footprint laid down a few times, each lower and
  // fainter. A Gaussian `shadowBlur` over a polygon this size was the single most
  // expensive thing in the frame on a machine without GPU canvas.
  const lift = Math.max(0.2, Math.sin((cam.pitch * Math.PI) / 180));
  for (const [dy, alpha] of [[18, 0.16], [7, 0.3]] as const) {
    ctx.fillStyle = `rgba(1, 4, 12, ${alpha})`;
    ctx.beginPath();
    ring(ctx, bottom, dy * lift);
    ctx.fill();
  }

  // Walls, back to front. Lit from the north-west; the coast is tinted as water-facing.
  // Only the walls facing the camera: one turned away is behind the top face anyway,
  // and skipping it halves the work. Straight down, no wall shows at all.
  const walls: { i: number; depth: number; light: number }[] = [];
  const yaw = (cam.yaw * Math.PI) / 180;
  const [sinYaw, cosYaw] = [Math.sin(yaw), Math.cos(yaw)];
  for (let i = 0; cam.pitch > 1 && i < n - 1; i += 1) {
    const [x0, y0] = AP_OUTLINE_WORLD[i];
    const [x1, y1] = AP_OUTLINE_WORLD[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    // The outward normal, turned into the camera's frame: negative y faces the viewer.
    const [nx, ny] = [(y1 - y0) / len * OUTLINE_TURN, -(x1 - x0) / len * OUTLINE_TURN];
    if (nx * sinYaw + ny * cosYaw > 0.08) continue;
    const light = 0.5 + 0.5 * (((y1 - y0) / len) * -0.7 + ((x1 - x0) / len) * -0.7);
    walls.push({ i, depth: (top[i].depth + top[i + 1].depth) / 2, light: Math.max(0, Math.min(1, light)) });
  }
  walls.sort((a, b) => b.depth - a.depth);
  ctx.lineWidth = 0.6;
  // Batched like the terrain: by colour, within chunks taken far to near.
  for (let start = 0; start < walls.length; start += 400) {
    const chunk = new Map<string, Path2D>();
    for (const { i, light } of walls.slice(start, start + 400)) {
      const coast = layers?.coastEdge[i];
      // Opaque, mixed down towards the night rather than faded: a translucent wall lets
      // the sea rings and the shadow show through the side of the state. Floored well
      // above black: a wall in a concave notch of the border faces away from the light
      // and read as a hole in the state.
      const f = 0.45 + 0.5 * (Math.round(light * 10) / 10);
      const [r, g, b] = coast ? [34, 98, 138] : [40, 70, 114];
      const fill = `rgb(${Math.round(6 + (r - 6) * f)},${Math.round(20 + (g - 20) * f)},${Math.round(43 + (b - 43) * f)})`;
      let path = chunk.get(fill);
      if (!path) { path = new Path2D(); chunk.set(fill, path); }
      path.moveTo(top[i].x, top[i].y);
      path.lineTo(top[i + 1].x, top[i + 1].y);
      path.lineTo(bottom[i + 1].x, bottom[i + 1].y);
      path.lineTo(bottom[i].x, bottom[i].y);
      path.closePath();
    }
    for (const [fill, path] of chunk) {
      ctx.fillStyle = fill;
      ctx.strokeStyle = fill;
      ctx.fill(path);
      ctx.stroke(path);
    }
  }
  if (layers) {
    // The waterline, where the walls meet the sea.
    ctx.strokeStyle = "rgba(103, 232, 249, 0.32)";
    ctx.lineWidth = 1;
    strokeLines(ctx, P, layers.coast, zSea);
  }

  // The top face, clipped to the state; everything drawn ON the state goes inside.
  ctx.save();
  ctx.beginPath();
  ring(ctx, top);
  if (layers) {
    for (const hole of layers.holes) trace(ctx, P, hole, zTop, true);
    for (const island of layers.islands) trace(ctx, P, island, zTop, true);
  }
  ctx.clip("evenodd");
  const minX = Math.min(...top.map((p) => p.x));
  const maxX = Math.max(...top.map((p) => p.x));
  const minY = Math.min(...top.map((p) => p.y));
  const maxY = Math.max(...top.map((p) => p.y));
  const under = ctx.createLinearGradient(minX, minY, maxX, maxY);
  under.addColorStop(0, "#1b3558");
  under.addColorStop(0.55, "#152b49");
  under.addColorStop(1, "#10223b");
  ctx.fillStyle = under;
  ctx.fillRect(minX - 2, minY - 2, maxX - minX + 4, maxY - minY + 4);

  if (layers) {
    drawTerrain(ctx, P, layers, cam, dpr, zTop, input.moving, level >= 3);
    if (input.relief > 0.04 && level < 2) {
      layers.contours.forEach((level, index) => {
        ctx.strokeStyle = `rgba(175, 230, 255, ${((0.16 + index * 0.05) * Math.min(1, input.relief * 1.5)).toFixed(3)})`;
        ctx.lineWidth = 0.8;
        strokeLines(ctx, P, level.lines, zTop);
      });
    }
    if (show.water) {
      ctx.fillStyle = "rgba(30, 160, 228, 0.5)";
      ctx.strokeStyle = "rgba(125, 211, 252, 0.85)";
      ctx.lineWidth = 0.8;
      for (const lake of layers.lakes) {
        ctx.beginPath();
        for (const ring of lake.rings) trace(ctx, P, ring, zTop, true);
        ctx.fill();
        ctx.stroke();
      }
      for (const pass of [0, 1]) {
        for (const river of layers.rivers) {
          const major = river.rank <= 2;
          if (!pass && (!major || level >= 3)) continue; // Only the great rivers carry a halo.
          const w = (river.rank === 1 ? 2 : major ? 1.35 : 0.75) * wz;
          ctx.strokeStyle = pass ? (major ? "rgba(140, 220, 255, 0.92)" : "rgba(125, 211, 252, 0.55)") : "rgba(56, 189, 248, 0.18)";
          ctx.lineWidth = pass ? w : w + 4;
          strokeLines(ctx, P, river.lines, (e) => zTop(e) + 0.1);
        }
      }
    }
    // Hologram scanlines across the face of the state — fixed to the screen, so the
    // ground moves under them as it turns.
    const scan = level < 2 ? scanPattern(ctx) : null;
    if (scan) {
      ctx.fillStyle = scan;
      ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    }
    if (show.districts) {
      ctx.strokeStyle = "rgba(205, 228, 255, 0.46)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      strokeLines(ctx, P, layers.districtBorders, (e) => zTop(e) + 0.1);
      ctx.setLineDash([]);
    }
  }
  ctx.restore();

  // The rim of the top face: the land border in blue, the coast in cyan with a halo.
  if (layers) {
    ctx.strokeStyle = "rgba(110, 175, 245, 0.9)";
    ctx.lineWidth = 1.1;
    strokeLines(ctx, P, [...layers.landBorder, ...layers.holes], zTop);
    ctx.strokeStyle = "rgba(34, 211, 238, 0.2)";
    ctx.lineWidth = 5;
    strokeLines(ctx, P, layers.coast, zTop);
    ctx.strokeStyle = "rgba(103, 232, 249, 0.95)";
    ctx.lineWidth = 1.3;
    strokeLines(ctx, P, layers.coast, zTop);
  } else {
    ctx.strokeStyle = "#5aa2ee";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ring(ctx, top);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- stocking points
  if (show.points && input.nodes.length) {
    const radius = (kind: string, scale: number) =>
      (kind === "MAIN" ? 3.4 : kind === "MDP" ? 2.5 : 1.55) * Math.min(1.6, scale * Math.sqrt(cam.zoom));
    // One path per kind for each of halo and core: eight hundred points were two
    // thousand four hundred draw calls a frame, and draw calls were the frame.
    const kinds = ["LIP", "other", "MDP", "MAIN"];
    const halo = new Map<string, Path2D>();
    const core = new Map<string, Path2D>();
    const few: { p: Projected; kind: string }[] = [];
    for (const node of input.nodes) {
      const { p } = node;
      if (p.x < -10 || p.y < -10 || p.x > W + 10 || p.y > H + 10) continue;
      const kind = NODE_COLORS[node.kind] ? node.kind : "other";
      const r = radius(kind, p.scale);
      if (kind === "LIP" || kind === "other") {
        let h = halo.get(kind);
        if (!h) { h = new Path2D(); halo.set(kind, h); }
        h.moveTo(p.x + r * 2.6, p.y);
        h.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
      } else {
        few.push({ p, kind });
      }
      let c = core.get(kind);
      if (!c) { c = new Path2D(); core.set(kind, c); }
      c.moveTo(p.x + r, p.y);
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    ctx.save();
    // Additive: where points crowd, the glow builds up — density reads without a legend.
    ctx.globalCompositeOperation = "lighter";
    for (const [kind, path] of halo) {
      ctx.fillStyle = NODE_COLORS[kind];
      ctx.globalAlpha = 0.09;
      ctx.fill(path);
    }
    // The few big points keep a soft sprite glow.
    for (const { p, kind } of few) {
      const sprite = glowSprite(NODE_COLORS[kind]);
      if (!sprite) continue;
      const size = radius(kind, p.scale) * 5.5;
      ctx.globalAlpha = 0.6;
      ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
    }
    ctx.restore();
    // A dark rim, so a point reads against the bright ridges as well as the plain.
    ctx.strokeStyle = "rgba(4, 14, 32, 0.55)";
    ctx.lineWidth = 0.6;
    for (const kind of kinds) {
      const path = core.get(kind);
      if (!path) continue;
      ctx.globalAlpha = kind === "LIP" ? 0.9 : 1;
      ctx.fillStyle = NODE_COLORS[kind];
      ctx.fill(path);
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  if (layers) drawLabels(ctx, P, layers, input, zTop);
}

/** The relief as a mesh of hillshaded quads, painted far to near so ridges overlap
 *  what is behind them. Only cells on screen are drawn. */
let terrainCanvas: HTMLCanvasElement | null = null;
/** Screen positions of the grid, reused frame to frame: two fresh 16k-float arrays a
 *  frame were garbage an orbit produced sixty times a second, and the collector's
 *  pauses were the hitches. Every index read in a frame is written in that frame. */
let screenX = new Float32Array(0);
let screenY = new Float32Array(0);

function drawTerrain(main: CanvasRenderingContext2D, P: Project, layers: MapLayers, cam: Camera, dpr: number,
  z: (e: number) => number, moving = false, coarser = false) {
  // Painted small on a layer of its own and laid down scaled up, smoothed. Each cell is
  // one flat colour, and six-kilometre facets show as a staircase once the camera is
  // close; drawing at 1/F of the resolution and letting the upscale interpolate softens
  // them by about F pixels — a fraction of a cell, so a ridge stays a ridge — and it
  // paints F² fewer pixels, where a blur filter would have added a full-canvas pass.
  const cellPx = layers.terrain.step * 111.32 * cam.zoom;
  const F = Math.min(6, Math.max(1, cellPx * 0.4));
  const scale = dpr / F;
  const W0 = Math.max(1, Math.round(cam.width * scale));
  const H0 = Math.max(1, Math.round(cam.height * scale));
  terrainCanvas ??= typeof document === "undefined" ? null : document.createElement("canvas");
  const layer = terrainCanvas;
  const ctx = layer?.getContext("2d") ?? main;
  if (layer && ctx !== main) {
    if (layer.width !== W0) layer.width = W0;
    if (layer.height !== H0) layer.height = H0;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, cam.width, cam.height);
  }
  const t = layers.terrain;
  const { rows, cols, valid, wx, wy, elev, cellColor, palette, vertexColor } = t;
  // Level of detail, while the camera moves: every second or third grid line, a quarter
  // or a ninth of the cells. A still frame always has every cell.
  const k = moving ? (cellPx < 9 ? 3 : cellPx < 24 ? 2 : 1) + (coarser ? 1 : 0) : 1;
  if (screenX.length < rows * cols) {
    screenX = new Float32Array(rows * cols);
    screenY = new Float32Array(rows * cols);
  }
  const sx = screenX;
  const sy = screenY;
  for (let r = 0; r < rows; r += 1) {
    if (r % k && r !== rows - 1) continue;
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      if (!valid[i] || (c % k && c !== cols - 1)) continue;
      const p = P(wx[i], wy[i], z(elev[i]));
      sx[i] = p.x;
      sy[i] = p.y;
    }
  }
  const yaw = (cam.yaw * Math.PI) / 180;
  // Depth grows along (x sin yaw + y cos yaw): start from whichever end is farther.
  const rowsFar = Math.cos(yaw) > 0;
  const colsFar = Math.sin(yaw) > 0;
  const rowsOuter = Math.abs(Math.cos(yaw)) >= Math.abs(Math.sin(yaw));
  const W = cam.width;
  const H = cam.height;
  // The seam-hiding stroke only matters at full resolution; smaller, the upscale
  // closes the hairlines between cells on its own.
  const seams = F < 1.6;
  ctx.lineWidth = 0.9 * F;
  // Cells are gathered per colour and filled together, a few rows at a time: within a
  // band the order is lost, between bands far is still painted before near, which is
  // what lets a ridge overlap the valley behind it.
  // Close up, a cell spans tens of pixels and one flat colour reads as a tile: it is
  // cut into n x n pieces coloured by blending its four corners (Gouraud shading, by
  // hand — a canvas has no per-vertex colour). Only cells on screen are cut, and there
  // are few of those this close.
  const n = moving ? 1 : Math.min(6, Math.floor(cellPx / 14));
  const blended = new Map<string, Path2D>();
  let batch = new Map<number, Path2D>();
  const flush = () => {
    for (const [css, path] of blended) {
      ctx.fillStyle = css;
      ctx.fill(path);
      ctx.strokeStyle = css;
      ctx.stroke(path);
    }
    blended.clear();
    for (const [key, path] of batch) {
      ctx.fillStyle = palette[key];
      ctx.fill(path);
      if (seams) {
        ctx.strokeStyle = palette[key];
        ctx.stroke(path);
      }
    }
    batch = new Map();
  };
  const cell = (r: number, c: number) => {
    const r1 = Math.min(rows - 1, r + k);
    const c1 = Math.min(cols - 1, c + k);
    const a = r * cols + c;
    const b = r * cols + c1;
    const d = r1 * cols + c;
    const e = r1 * cols + c1;
    if (!valid[a] || !valid[b] || !valid[d] || !valid[e]) return;
    const key = cellColor[r * (cols - 1) + c] || cellColor[Math.min(rows - 2, r + 1) * (cols - 1) + Math.min(cols - 2, c + 1)];
    if (!key) return;
    const x0 = Math.min(sx[a], sx[b], sx[d], sx[e]);
    const x1 = Math.max(sx[a], sx[b], sx[d], sx[e]);
    const y0 = Math.min(sy[a], sy[b], sy[d], sy[e]);
    const y1 = Math.max(sy[a], sy[b], sy[d], sy[e]);
    if (x1 < 0 || y1 < 0 || x0 > W || y0 > H) return;
    if (n > 1 && k === 1) {
      const col = (v: number, ch: number) => vertexColor[v * 3 + ch];
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          const u0 = j / n;
          const u1 = (j + 1) / n;
          const v0 = i / n;
          const v1 = (i + 1) / n;
          // Bilinear across the projected quad: a, b along the row, d, e the next row.
          const px = (u: number, v: number) => (sx[a] * (1 - u) + sx[b] * u) * (1 - v) + (sx[d] * (1 - u) + sx[e] * u) * v;
          const py = (u: number, v: number) => (sy[a] * (1 - u) + sy[b] * u) * (1 - v) + (sy[d] * (1 - u) + sy[e] * u) * v;
          const um = (u0 + u1) / 2;
          const vm = (v0 + v1) / 2;
          const rgb = [0, 1, 2].map((ch) =>
            (col(a, ch) * (1 - um) + col(b, ch) * um) * (1 - vm) + (col(d, ch) * (1 - um) + col(e, ch) * um) * vm);
          // Quantised to 4 levels a channel so neighbouring pieces still share a fill.
          const css = `rgb(${rgb.map((v) => Math.round(v / 4) * 4).join(",")})`;
          let piece = blended.get(css);
          if (!piece) { piece = new Path2D(); blended.set(css, piece); }
          piece.moveTo(px(u0, v0), py(u0, v0));
          piece.lineTo(px(u1, v0), py(u1, v0));
          piece.lineTo(px(u1, v1), py(u1, v1));
          piece.lineTo(px(u0, v1), py(u0, v1));
          piece.closePath();
        }
      }
      return;
    }
    let path = batch.get(key);
    if (!path) { path = new Path2D(); batch.set(key, path); }
    path.moveTo(sx[a], sy[a]);
    path.lineTo(sx[b], sy[b]);
    path.lineTo(sx[e], sy[e]);
    path.lineTo(sx[d], sy[d]);
    path.closePath();
  };
  const R = Math.ceil((rows - 1) / k);
  const C = Math.ceil((cols - 1) / k);
  const BAND = k === 2 ? 5 : 6;
  if (rowsOuter) {
    for (let ri = 0; ri < R; ri += 1) {
      const r = (rowsFar ? R - 1 - ri : ri) * k;
      for (let ci = 0; ci < C; ci += 1) cell(r, (colsFar ? C - 1 - ci : ci) * k);
      if (ri % BAND === BAND - 1) flush();
    }
  } else {
    for (let ci = 0; ci < C; ci += 1) {
      const c = (colsFar ? C - 1 - ci : ci) * k;
      for (let ri = 0; ri < R; ri += 1) cell((rowsFar ? R - 1 - ri : ri) * k, c);
      if (ci % BAND === BAND - 1) flush();
    }
  }
  flush();
  if (layer && ctx !== main) {
    main.save();
    main.imageSmoothingEnabled = true;
    main.imageSmoothingQuality = "low";
    main.drawImage(layer, 0, 0, cam.width, cam.height);
    main.restore();
  }
}

interface Label {
  lat: number;
  lon: number;
  z: number;
  text: string;
  font: string;
  fill: string;
  spacing?: number;
  /** Visible from this many screen px per km. */
  minPx: number;
  maxPx?: number;
  marker?: { r: number; fill: string; ring?: string; diamond?: boolean };
  halo?: boolean;
  /** Drawn even where it collides — the capital and the big cities are the frame. */
  force?: boolean;
}

const widths = new Map<string, number>();

function drawLabels(ctx: CanvasRenderingContext2D, P: Project, layers: MapLayers, input: DrawInput, z: (e: number) => number) {
  const { cam, show } = input;
  const W = cam.width;
  const H = cam.height;
  const ground = (lat: number, lon: number) => z(elevationAt(layers.terrain, lat, lon));
  const labels: Label[] = [];
  const cityFont = (rank: number) => rank <= 1 ? "600 11.5px Inter, system-ui, sans-serif"
    : rank === 2 ? "500 10.5px Inter, system-ui, sans-serif" : "500 10px Inter, system-ui, sans-serif";

  if (show.places) {
    for (const c of layers.cities.filter((city) => city.rank <= 1)) {
      const capital = c.kind === "capital";
      labels.push({ lat: c.lat, lon: c.lon, z: ground(c.lat, c.lon), text: capital ? `${c.name} · Capital` : c.name,
        font: capital ? "700 11.5px Inter, system-ui, sans-serif" : cityFont(1),
        fill: capital ? "#fde68a" : "#e3edff", minPx: 0, halo: true, force: capital,
        marker: capital ? { r: 3.6, fill: "#fbbf24", diamond: true } : { r: 2.4, fill: "#ffffff", ring: "rgba(255,255,255,0.35)" } });
    }
    for (const c of layers.cities.filter((city) => city.rank === 2)) {
      labels.push({ lat: c.lat, lon: c.lon, z: ground(c.lat, c.lon), text: c.name, font: cityFont(2),
        fill: "#c9d8f0", minPx: 0.95, halo: true, marker: { r: 1.9, fill: "#dbe7fb" } });
    }
  }
  if (show.districts) {
    for (const d of layers.districts) {
      labels.push({ lat: d.label.lat, lon: d.label.lon, z: ground(d.label.lat, d.label.lon),
        text: d.name.toUpperCase(), font: "700 8.5px Inter, system-ui, sans-serif", spacing: 1.6,
        fill: "rgba(196, 220, 252, 0.66)", minPx: 0.7, halo: true });
    }
  }
  if (show.water) {
    for (const r of layers.rivers) {
      if (!r.label) continue;
      labels.push({ lat: r.label.lat, lon: r.label.lon, z: ground(r.label.lat, r.label.lon) + 0.1, text: r.name,
        font: "italic 500 10px Inter, system-ui, sans-serif", fill: "rgba(125, 211, 252, 0.85)",
        minPx: r.rank <= 2 ? 0.8 : 2.1, halo: true });
    }
    for (const l of layers.lakes) {
      labels.push({ lat: l.label.lat, lon: l.label.lon, z: ground(l.label.lat, l.label.lon), text: l.name,
        font: "italic 500 9.5px Inter, system-ui, sans-serif", fill: "rgba(165, 225, 255, 0.8)", minPx: 1.5, halo: true });
    }
  }
  if (show.context) {
    labels.push({ lat: 15.35, lon: 82.9, z: 0, text: "BAY OF BENGAL", font: "600 12px Inter, system-ui, sans-serif",
      spacing: 6, fill: "rgba(125, 211, 252, 0.3)", minPx: 0 });
    for (const n of layers.neighbours) {
      if (!n.label) continue;
      labels.push({ lat: n.label.lat, lon: n.label.lon, z: 0, text: n.name.toUpperCase(),
        font: "600 10px Inter, system-ui, sans-serif", spacing: 3, fill: "rgba(150, 172, 212, 0.4)", minPx: 0 });
    }
    for (const c of layers.context) {
      labels.push({ lat: c.lat, lon: c.lon, z: 0, text: c.name, font: "500 10px Inter, system-ui, sans-serif",
        fill: "rgba(170, 184, 208, 0.6)", minPx: 0, halo: true, marker: { r: 1.8, fill: "rgba(170,184,208,0.7)" } });
    }
  }
  if (show.places) {
    for (const c of layers.cities.filter((city) => city.rank >= 3)) {
      labels.push({ lat: c.lat, lon: c.lon, z: ground(c.lat, c.lon), text: c.name, font: cityFont(3),
        fill: "#a9bddb", minPx: 1.9, halo: true, marker: { r: 1.5, fill: "#c3d3ea" } });
    }
  }

  const taken: [number, number, number, number][] = [...(input.reserved ?? [])];
  const free = (b: [number, number, number, number]) =>
    !taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
  const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  ctx.textBaseline = "middle";
  for (const label of labels) {
    const [x, y] = toWorld(label.lat, label.lon);
    const p = P(x, y, label.z);
    const pxPerKm = cam.zoom * p.scale;
    if (pxPerKm < label.minPx || (label.maxPx && pxPerKm > label.maxPx)) continue;
    if (p.x < -40 || p.y < -20 || p.x > W + 40 || p.y > H + 20) continue;
    ctx.font = label.font;
    if ("letterSpacing" in ctx) spaced.letterSpacing = `${label.spacing ?? 0}px`;
    const key = `${label.font}|${label.spacing ?? 0}|${label.text}`;
    let w = widths.get(key);
    if (w === undefined) { w = ctx.measureText(label.text).width; widths.set(key, w); }
    const lh = parseFloat(label.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "10") + 3;
    // A named place tries right of its dot, then left, above, below; anything else is
    // centred on its point and either fits or waits for more zoom.
    const r = label.marker ? label.marker.r + 4 : 0;
    const spots: [number, number][] = label.marker
      ? [[p.x + r, p.y], [p.x - r - w, p.y], [p.x - w / 2, p.y - lh], [p.x - w / 2, p.y + lh]]
      : [[p.x - w / 2, p.y]];
    const boxAt = ([sx, sy]: [number, number]): [number, number, number, number] =>
      [sx - 3, sy - lh / 2 - 1, sx + w + 3, sy + lh / 2 + 1];
    // The dot is checked as well as the name: a dot painted over a label already drawn
    // eats its letters (Bapatla town's dot turned the district's B into a P).
    const mr = label.marker ? (label.marker.ring ? label.marker.r + 2.4 : label.marker.r) + 1 : 0;
    const markerBox: [number, number, number, number] | null = label.marker
      ? [p.x - mr, p.y - mr, p.x + mr, p.y + mr] : null;
    if (markerBox && !label.force && !free(markerBox)) continue;
    const spot = spots.find((s) => free(boxAt(s))) ?? (label.force ? spots[0] : null);
    if (!spot) continue;
    const [tx, ty] = spot;
    const box = boxAt(spot);
    taken.push(box);
    if (markerBox) taken.push(markerBox);
    if (label.marker) {
      const m = label.marker;
      if (m.ring) {
        ctx.fillStyle = m.ring;
        ctx.beginPath();
        ctx.arc(p.x, p.y, m.r + 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = m.fill;
      ctx.strokeStyle = "rgba(4, 11, 26, 0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (m.diamond) {
        ctx.moveTo(p.x, p.y - m.r - 1); ctx.lineTo(p.x + m.r, p.y); ctx.lineTo(p.x, p.y + m.r + 1); ctx.lineTo(p.x - m.r, p.y);
        ctx.closePath();
      } else {
        ctx.arc(p.x, p.y, m.r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
    }
    if (label.halo) {
      ctx.strokeStyle = "rgba(4, 11, 26, 0.82)";
      ctx.lineWidth = 3;
      ctx.strokeText(label.text, tx, ty);
    }
    ctx.fillStyle = label.fill;
    ctx.fillText(label.text, tx, ty);
  }
  if ("letterSpacing" in ctx) spaced.letterSpacing = "0px";
}
