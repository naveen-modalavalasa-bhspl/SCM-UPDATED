import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Box, Crosshair, Expand, Layers, LocateFixed, Minus, Mountain, Orbit, Plus, Shrink, Square, X,
} from "lucide-react";
import {
  AP_OUTLINE_WORLD, PITCH_LIMITS, ZOOM_LIMITS, arc, frame, project, toWorld, unproject,
  type Camera, type Vec2, type Vec3,
} from "./apGeo";
import {
  districtAt, elevationAt, formatLatLon, loadMapLayers, niceScale, type District, type MapLayers,
} from "./apTerrain";
import {
  DEFAULT_TOGGLES, NODE_COLORS, drawMap, groundZ, lineZ, slabKm, type LayerToggles,
} from "./apMapCanvas";
import { initialQuality, levelRatio, sampleFrame, type QualityState } from "./mapQuality";

/**
 * The Smart Load Planner's 3D map of Andhra Pradesh.
 *
 * The state as a raised slab with its real relief — the Eastern Ghats, the Nallamala
 * and Seshachalam hills rising out of the coastal plain — its 26 districts, its
 * rivers and reservoirs, the Bay of Bengal and the neighbouring states around it;
 * every stocking point on top, the consignments ready to go standing up as beams,
 * and the routes arcing between them.
 *
 * Two layers. A canvas paints the base map (`apMapCanvas.ts`) — twenty thousand
 * vertices a frame, which as SVG was a coordinate string rebuilt per frame. SVG above
 * it carries what is clicked and animated: routes, stops, pins, the origin, the
 * hovered district. Both read the same projection (`apGeo.ts`), so they never drift.
 *
 * Drag to orbit, Shift/right-drag to pan, wheel or pinch to zoom toward the pointer,
 * double-click to dive in, arrow keys and +/− when focused. The base map loads lazily
 * (`apTerrain.loadMapLayers`); until it arrives the slab draws flat, so the map is
 * never blank and nothing waits on it.
 *
 * The canvas is a night map in both themes on purpose: route colour carries meaning,
 * and it reads the same on a dark slab whatever the page around it is doing.
 */

export interface MapNode {
  id: number;
  lat: number;
  lon: number;
  name: string;
  code?: string;
  kind?: string | null;
}

export type StopState = "planned" | "transit" | "delivered" | "acknowledged";

export interface MapStop {
  key: string | number;
  lat: number;
  lon: number;
  label: string;
  sequence: number;
  state?: StopState;
  /** Consignments coming off here. */
  count?: number;
}

export interface MapRoute {
  key: string;
  stops: MapStop[];
  emphasis: "active" | "ghost";
  returnToOrigin?: boolean;
  /** Which leg the truck is on (0 = origin → stop 1). Omit for no truck. */
  truckLeg?: number | null;
  /** Two-stop gradient for the route line. */
  colors?: [string, string];
}

export interface MapPin {
  key: string | number;
  lat: number;
  lon: number;
  label: string;
  /** Height of the beam grows with the load, capped. */
  weight?: number;
  tone?: "ready" | "picked" | "dim" | "alert";
}

/** The control column on the right edge, kept clear when framing. */
const CONTROLS_PX = 64;
const PIN = {
  ready: "#34d399",
  picked: "#f472b6",
  dim: "#64748b",
  alert: "#fb923c",
};
const STOP = {
  planned: "#38bdf8",
  transit: "#38bdf8",
  delivered: "#34d399",
  acknowledged: "#22c55e",
};
export const ROUTE_COLORS: [string, string][] = [
  ["#38bdf8", "#34d399"], ["#f472b6", "#fb923c"], ["#a78bfa", "#38bdf8"],
  ["#facc15", "#f97316"], ["#2dd4bf", "#a3e635"], ["#fb7185", "#c084fc"],
];
const KIND_WORD: Record<string, string> = { MAIN: "Central warehouse", MDP: "MDP", LIP: "LIP" };
const LAYER_ROWS: { key: keyof LayerToggles; label: string; hint: string }[] = [
  { key: "relief", label: "Terrain relief", hint: "SRTM elevation, raised" },
  { key: "districts", label: "Districts", hint: "The 26 districts of 2022" },
  { key: "water", label: "Rivers & reservoirs", hint: "Godavari, Krishna, Penna…" },
  { key: "places", label: "Cities & towns", hint: "Named as the zoom allows" },
  { key: "context", label: "Sea & neighbours", hint: "Bay of Bengal, bordering states" },
  { key: "points", label: "Stocking points", hint: "Every point on the masters" },
];
const TOGGLES_KEY = "scm.apmap.layers";
/** Orbit speed, per millisecond rather than per frame: a dropped frame is then a small
 *  jump at the same speed, not a stall, and a 144 Hz screen turns no faster than 60. */
const ORBIT_DEG_PER_MS = 0.0048;
/** What this machine can draw while moving, learned once per session: it is the
 *  machine that is slow, not the screen, so a map opened again starts where the last
 *  one finished learning. */
let learnedQuality: QualityState = initialQuality();

type CamState = Omit<Camera, "width" | "height">;

const clamp = (value: number, [low, high]: [number, number]) =>
  Math.min(high, Math.max(low, value));
const polyline = (points: { x: number; y: number }[]) =>
  points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

function readToggles(): LayerToggles {
  try {
    const raw = window.localStorage.getItem(TOGGLES_KEY);
    return raw ? { ...DEFAULT_TOGGLES, ...(JSON.parse(raw) as Partial<LayerToggles>) } : DEFAULT_TOGGLES;
  } catch {
    return DEFAULT_TOGGLES;
  }
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export function ApMap3D({
  nodes, origin, routes = [], pins = [], height: baseHeight = 520, focusKey, title, subtitle,
  badge, pickMode, onPinClick, onRouteClick, footer, children,
}: {
  nodes: MapNode[];
  origin?: { lat: number; lon: number; name: string } | null;
  routes?: MapRoute[];
  pins?: MapPin[];
  height?: number;
  /** Change it to re-frame the camera on whatever is emphasised now. */
  focusKey?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  /** While set, a click on the map reports where it landed instead of orbiting. */
  pickMode?: { label: string; onPick: (lat: number, lon: number) => void; onCancel?: () => void } | null;
  onPinClick?: (key: string | number) => void;
  onRouteClick?: (key: string) => void;
  footer?: ReactNode;
  /** Overlays that belong ON the map — drawn inside it, so full screen keeps them. */
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  // Full screen: the browser's own where it is allowed, else the map fills the window.
  // Either way the canvas takes the whole height, and Esc (or the button) gives it back.
  const [full, setFull] = useState(false);
  const [screenH, setScreenH] = useState(() => (typeof window === "undefined" ? 800 : window.innerHeight));
  const nativeFull = useRef(false);
  const height = full ? screenH : baseHeight;
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(900);
  // It opens low and turned away, then flies in to the state on the first framing.
  const [cam, setCam] = useState<CamState>({ yaw: -62, pitch: 16, zoom: 0.42, panX: 0, panY: -140 });
  const [orbit, setOrbit] = useState(false);
  const orbitRef = useRef(false);
  orbitRef.current = orbit;
  const [hover, setHover] = useState<{ x: number; y: number; text: string; sub?: string; color?: string; extra?: string } | null>(null);
  const [cursor, setCursor] = useState<{ lat: number; lon: number; district: District | null; elev: number | null } | null>(null);
  const [layers, setLayers] = useState<MapLayers | null>(null);
  const [show, setShow] = useState<LayerToggles>(readToggles);
  const [panel, setPanel] = useState(false);
  const [relief, setRelief] = useState(0);
  const reliefRef = useRef(0);
  reliefRef.current = relief;
  const drag = useRef<{ x: number; y: number; moved: boolean; pan: boolean; start: CamState } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; angle: number; start: CamState } | null>(null);
  const tween = useRef<number | null>(null);

  const camera: Camera = useMemo(() => ({ ...cam, width, height }), [cam, width, height]);
  // The state runs south-west to north-east, about 900 km by 300. In a tall box (a
  // phone, a narrow column) it is turned so that length runs up the screen instead of
  // across it, which roughly doubles how big it can be drawn.
  const homeYaw = height > width * 0.9 ? 42 : -18;
  const originChars = width < 520 ? 16 : 30;
  // The camera as it is this instant, and where the glide in flight is taking it. A
  // re-frame that starts mid-glide (the box getting its real width during the fly-in)
  // must aim from the one and keep the other's angle, or it lands on the angle the
  // fly-in started from.
  const camRef = useRef(cam);
  camRef.current = cam;
  const goal = useRef<CamState | null>(null);
  const [measured, setMeasured] = useState(false);

  useEffect(() => {
    let live = true;
    loadMapLayers().then((loaded) => { if (live) setLayers(loaded); }).catch(() => {
      // The flat slab is still a working map; the base layers are an enhancement.
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(TOGGLES_KEY, JSON.stringify(show)); } catch { /* private mode */ }
  }, [show]);

  // The relief rises out of the plain when the terrain arrives, and sinks when it is
  // switched off, rather than snapping.
  useEffect(() => {
    const target = layers && show.relief ? 1 : 0;
    if (reduced) { setRelief(target); return; }
    const from = reliefRef.current;
    if (from === target) return;
    const began = performance.now();
    let id = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / 1400);
      setRelief(from + (target - from) * (1 - (1 - t) ** 3));
      if (t < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [layers, show.relief, reduced]);

  const slab = slabKm(cam.zoom);
  const zAt = useCallback((lat: number, lon: number) => groundZ(layers, relief, lat, lon, slab), [layers, relief, slab]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(280, Math.round(entry.contentRect.width)));
      setMeasured(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const exitFull = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    nativeFull.current = false;
    setFull(false);
  }, []);
  const toggleFull = useCallback(async () => {
    if (full) { exitFull(); return; }
    setScreenH(window.innerHeight);
    try {
      await box.current?.requestFullscreen?.();
      nativeFull.current = Boolean(document.fullscreenElement);
    } catch {
      nativeFull.current = false;
    }
    setScreenH(window.innerHeight);
    setFull(true);
  }, [full, exitFull]);
  useEffect(() => {
    if (!full) return;
    const onResize = () => setScreenH(window.innerHeight);
    // The browser leaving full screen on its own (Esc, F11, a tab switch) ends ours too.
    const onChange = () => { if (!document.fullscreenElement && nativeFull.current) exitFull(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") exitFull(); };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("resize", onResize);
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("keydown", onKey);
    };
  }, [full, exitFull]);

  // Glide to a new framing rather than jumping, so the eye follows what moved.
  const glideTo = useCallback((target: Partial<CamState>, duration = 650) => {
    if (tween.current) cancelAnimationFrame(tween.current);
    const from = { ...camRef.current };
    goal.current = { ...from, ...target };
    const began = performance.now();
    const length = reduced ? 0 : duration;
    const step = (now: number) => {
      const t = length ? Math.min(1, (now - began) / length) : 1;
      const ease = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      setCam({
        yaw: from.yaw + ((target.yaw ?? from.yaw) - from.yaw) * ease,
        pitch: from.pitch + ((target.pitch ?? from.pitch) - from.pitch) * ease,
        zoom: from.zoom + ((target.zoom ?? from.zoom) - from.zoom) * ease,
        panX: from.panX + ((target.panX ?? from.panX) - from.panX) * ease,
        panY: from.panY + ((target.panY ?? from.panY) - from.panY) * ease,
      });
      tween.current = t < 1 ? requestAnimationFrame(step) : null;
      if (t >= 1) goal.current = null;
    };
    tween.current = requestAnimationFrame(step);
  }, [reduced]);

  const focusPoints = useCallback((): (Vec2 | Vec3)[] => {
    // Framed at the heights they are drawn at: the origin's beam stands 48 km over its
    // gate, and framing only the gate put its START label off the top of the canvas.
    const at = (lat: number, lon: number, lift = 0): Vec3 => [...toWorld(lat, lon), zAt(lat, lon) + lift];
    const active = routes.filter((route) => route.emphasis === "active");
    const pts: Vec3[] = [];
    for (const route of active.length ? active : []) {
      for (const stop of route.stops) pts.push(at(stop.lat, stop.lon));
    }
    if (!pts.length) for (const pin of pins) pts.push(at(pin.lat, pin.lon, 30));
    if (pts.length && origin) pts.push(at(origin.lat, origin.lon), at(origin.lat, origin.lon, 56));
    return pts.length >= 2 ? pts : AP_OUTLINE_WORLD;
  }, [routes, pins, origin, zAt]);

  const fit = useCallback((pitch = goal.current?.pitch ?? cam.pitch, yaw = goal.current?.yaw ?? cam.yaw, duration = 650) => {
    const points = focusPoints();
    // A route is framed looser than the whole state: its labels run to the right of
    // each stop and its arcs rise above them, and the controls sit on the right edge.
    const margin = points === AP_OUTLINE_WORLD ? 0.06 : 0.17;
    const view = frame(points, width - CONTROLS_PX, height, pitch, margin, yaw);
    // Framed for the canvas minus the control column, then slid left by half of it,
    // so nothing ends up under the buttons.
    const at = { ...view, pitch, yaw, width, height };
    const centre = unproject(at, width / 2, height / 2);
    const shifted = unproject(at, width / 2 + CONTROLS_PX / 2, height / 2);
    const [cx, cy] = toWorld(centre.lat, centre.lon);
    const [sx, sy] = toWorld(shifted.lat, shifted.lon);
    glideTo({ ...view, panX: view.panX + sx - cx, panY: view.panY + sy - cy, pitch, yaw }, duration);
  }, [cam.pitch, cam.yaw, focusPoints, glideTo, width, height]);

  // Re-frame when the caller says the subject changed, or the box first gets a size.
  const framedFor = useRef<string | null>(null);
  useEffect(() => {
    // The canvas size is part of the key, so going in and out of full screen re-frames
    // on the size it actually lands on, not the one it is leaving.
    // Nothing is framed before the box has been measured: framing for the default
    // width and then again for the real one was two glides, the second cutting the
    // fly-in short.
    if (!measured) return;
    const key = `${focusKey ?? ""}|${Math.round(width / 40)}x${Math.round(height / 40)}`;
    if (framedFor.current === key) return;
    const first = framedFor.current === null;
    framedFor.current = key;
    // The first framing is the fly-in: from low and turned away, onto the state.
    if (first) fit(46, homeYaw, 1900);
    else fit();
  }, [focusKey, width, height, fit, measured]);

  useEffect(() => {
    if (!orbit) return;
    let frameId = 0;
    let last = 0;
    const spin = (now: number) => {
      const dt = last ? Math.min(50, now - last) : 1000 / 60;
      last = now;
      setCam((current) => ({ ...current, yaw: current.yaw + ORBIT_DEG_PER_MS * dt }));
      frameId = requestAnimationFrame(spin);
    };
    frameId = requestAnimationFrame(spin);
    return () => cancelAnimationFrame(frameId);
  }, [orbit]);

  /** Zoom by `factor` keeping the ground under (sx, sy) where it is. */
  const zoomAbout = useCallback((current: CamState, factor: number, sx: number, sy: number): CamState => {
    const whole = { ...current, width, height };
    const zoom = clamp(current.zoom * factor, ZOOM_LIMITS);
    const before = unproject(whole, sx, sy, slabKm(current.zoom));
    const after = unproject({ ...whole, zoom }, sx, sy, slabKm(zoom));
    const [bx, by] = toWorld(before.lat, before.lon);
    const [ax, ay] = toWorld(after.lat, after.lon);
    return { ...current, zoom, panX: current.panX + bx - ax, panY: current.panY + by - ay };
  }, [width, height]);

  // The wheel needs a non-passive listener to keep the page from scrolling under it.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (tween.current) cancelAnimationFrame(tween.current);
      goal.current = null;
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0014);
      setCam((current) => zoomAbout(current, factor, event.clientX - rect.left, event.clientY - rect.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAbout]);

  // ------------------------------------------------------------------ geometry
  const projectedNodes = useMemo(() => nodes.map((node) => {
    const [x, y] = toWorld(node.lat, node.lon);
    return { node, kind: (node.kind ?? "").toUpperCase(), p: project(camera, [x, y, zAt(node.lat, node.lon)]) };
  }), [nodes, camera, zAt]);

  const originP = useMemo(() => {
    if (!origin) return null;
    const [x, y] = toWorld(origin.lat, origin.lon);
    const z = zAt(origin.lat, origin.lon);
    return { ground: project(camera, [x, y, z]), head: project(camera, [x, y, z + 48]) };
  }, [origin, camera, zAt]);

  // START sits right of its beam unless that would run it under the controls.
  const originLabel = useMemo(() => {
    if (!originP || !origin) return null;
    const name = origin.name.length > originChars ? `${origin.name.slice(0, originChars - 1)}…` : origin.name;
    const text = `START · ${name}`;
    const w = text.length * 11.5 * 0.62;
    const room = width - CONTROLS_PX - (originP.head.x + 11);
    if (room >= w) return { text, x: originP.head.x + 11, anchor: "start" as const };
    // Left of the beam, but never off the left edge of the canvas.
    return { text, x: Math.max(6 + w, originP.head.x - 11), anchor: "end" as const };
  }, [originP, origin, originChars, width]);

  const drawnRoutes = useMemo(() => routes.map((route, index) => {
    if (!origin) return null;
    const places = [origin, ...route.stops];
    const chain: Vec2[] = places.map((p) => toWorld(p.lat, p.lon));
    const heights = places.map((p) => zAt(p.lat, p.lon));
    const legs: { pts: string; ret: boolean; path: string }[] = [];
    for (let i = 0; i < chain.length - 1; i += 1) {
      const pts = arc(chain[i], chain[i + 1], heights[i], 24, heights[i + 1]).map((v: Vec3) => project(camera, v));
      legs.push({ pts: polyline(pts), ret: false,
        path: `M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L")}` });
    }
    if (route.returnToOrigin && chain.length > 1) {
      const last = chain.length - 1;
      const pts = arc(chain[last], chain[0], heights[last], 24, heights[0]).map((v) => project(camera, v));
      legs.push({ pts: polyline(pts), ret: true, path: "" });
    }
    const stops = route.stops.map((stop) => {
      const [x, y] = toWorld(stop.lat, stop.lon);
      return { stop, p: project(camera, [x, y, zAt(stop.lat, stop.lon)]) };
    });
    return { route, legs, stops, colors: route.colors ?? ROUTE_COLORS[index % ROUTE_COLORS.length] };
  }).filter(Boolean) as {
    route: MapRoute; legs: { pts: string; ret: boolean; path: string }[];
    stops: { stop: MapStop; p: ReturnType<typeof project> }[]; colors: [string, string];
  }[], [routes, origin, camera, zAt]);

  const drawnPins = useMemo(() => pins.map((pin) => {
    const [x, y] = toWorld(pin.lat, pin.lon);
    const z = zAt(pin.lat, pin.lon);
    const rise = 16 + Math.min(46, Math.sqrt(Math.max(0, pin.weight ?? 0)) * 1.6);
    return { pin, base: project(camera, [x, y, z]), head: project(camera, [x, y, z + rise]) };
  }).sort((a, b) => b.base.depth - a.base.depth), [pins, camera, zAt]);

  // The base map. A layout effect, so the canvas and the SVG over it change in the
  // same frame — a route never floats a frame ahead of the ground under it.
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  // Where the SVG layer writes text, so the canvas's place names step aside for it.
  const reserved = useMemo(() => {
    // The chrome over the map too: the title, the control column and the legend strip,
    // so no place name is printed underneath a button.
    const boxes: [number, number, number, number][] = [
      [width - CONTROLS_PX, 0, width, height],
      [0, height - 44, width, height],
    ];
    if (title || subtitle) boxes.push([0, 0, Math.min(width - CONTROLS_PX, 380), 64]);
    const text = (x: number, y: number, chars: number, px: number) =>
      boxes.push([x - 2, y - px, x + chars * px * 0.62 + 4, y + 4]);
    if (originP && origin && originLabel) {
      const w = originLabel.text.length * 11.5 * 0.62;
      text(originLabel.anchor === "end" ? originLabel.x - w : originLabel.x, originP.head.y - 6, originLabel.text.length, 11.5);
    }
    for (const { route, stops } of drawnRoutes) {
      if (route.emphasis !== "active") continue;
      for (const { stop, p } of stops) {
        boxes.push([p.x - 12, p.y - 12, p.x + 12, p.y + 12]);
        text(p.x + 13, p.y - 9, Math.min(36, stop.label.length + 4), 11);
      }
    }
    return boxes;
  }, [originP, origin, originLabel, drawnRoutes, width, height, title, subtitle]);
  // While the camera is moving, quality is ADAPTIVE (2026-09-28, reworked 2026-09-29).
  // A move starts at whatever this machine has learned it can hold, steps down only
  // when frames measurably cost too much, and back up when there is time to spare
  // (`mapQuality.ts` says how, and why timing drawMap alone missed an orbit's lag).
  // Once still for a moment there is always one full-quality frame.
  const lastMove = useRef(0);
  const lastDraw = useRef(0);
  const prevCam = useRef(cam);
  const settleTimer = useRef<number | null>(null);
  const [settled, setSettled] = useState(0);
  // Effects nobody can see on a map in motion — the running coast light, the sweep,
  // SVG glow filters, backdrop blurs over a canvas that changed — each cost a full
  // re-rasterise per frame, and none of it is inside drawMap. They sit out the move.
  const [inMotion, setInMotion] = useState(false);
  const inMotionRef = useRef(false);
  useEffect(() => () => { if (settleTimer.current) window.clearTimeout(settleTimer.current); }, []);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const now = performance.now();
    const moved = prevCam.current !== cam;
    prevCam.current = cam;
    const moving = moved && now - lastMove.current < 180;
    if (moved) lastMove.current = now;
    const level = moving ? learnedQuality.level : 0;
    const ratio = levelRatio(level, dpr);
    const w = Math.round(width * ratio);
    const h = Math.round(height * ratio);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const started = performance.now();
    drawMap(ctx, { cam: camera, dpr: ratio, layers, show, relief, nodes: projectedNodes, reserved, moving: level >= 1 });
    if (moving) {
      // Frame to frame is the whole frame's cost, but only while requestAnimationFrame
      // sets the pace; a drag's pace is the hand's.
      const paced = orbitRef.current || tween.current != null;
      const gap = now - lastDraw.current;
      learnedQuality = sampleFrame(learnedQuality, performance.now() - started, paced && gap < 100 ? gap : null);
      if (!inMotionRef.current) { inMotionRef.current = true; setInMotion(true); }
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        inMotionRef.current = false;
        setInMotion(false);
        setSettled((n) => n + 1);
      }, 140);
    }
    lastDraw.current = now;
  }, [cam, camera, dpr, layers, show, relief, projectedNodes, width, height, reserved, settled]);

  // The coast as one path, for the light running along it.
  const coastPath = useMemo(() => {
    if (!layers || reduced || inMotion) return "";
    const parts: string[] = [];
    for (const line of layers.coast) {
      const pts: string[] = [];
      for (let i = 0; i < line.x.length; i += 2) {
        const p = project(camera, [line.x[i], line.y[i], lineZ(line.e[i], relief, slab)]);
        pts.push(`${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
      }
      parts.push(`M${pts.join("L")}`);
    }
    return parts.join("");
  }, [layers, camera, relief, reduced, slab, inMotion]);

  const hoverDistrict = cursor?.district ?? null;
  const districtPath = useMemo(() => {
    if (!hoverDistrict || !layers || inMotion) return "";
    return hoverDistrict.world.map((ring) => {
      const pts: string[] = [];
      for (let i = 0; i < ring.x.length; i += 1) {
        const p = project(camera, [ring.x[i], ring.y[i], lineZ(ring.e[i], relief, slab) + 0.2]);
        pts.push(`${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
      }
      return `M${pts.join("L")}Z`;
    }).join("");
  }, [hoverDistrict, layers, camera, relief, slab, inMotion]);

  // ------------------------------------------------------------------ input
  const groundAt = (sx: number, sy: number) => {
    let at = unproject(camera, sx, sy, slab);
    for (let pass = 0; pass < 2; pass += 1) at = unproject(camera, sx, sy, zAt(at.lat, at.lon));
    return at;
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tween.current) cancelAnimationFrame(tween.current);
    goal.current = null;
    setOrbit(false);
    setPanel(false);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      // Two fingers: pinch to zoom, twist to turn. The single-finger drag is dropped
      // so lifting one finger does not register as a click.
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), start: { ...cam } };
      drag.current = null;
      return;
    }
    drag.current = { x: event.clientX, y: event.clientY, moved: false,
      pan: event.shiftKey || event.button === 2, start: { ...cam } };
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    const p2 = pinch.current;
    if (p2 && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      setCam({ ...p2.start, zoom: clamp(p2.start.zoom * (dist / Math.max(1, p2.dist)), ZOOM_LIMITS),
        yaw: p2.start.yaw - ((angle - p2.angle) * 180) / Math.PI });
      setHover(null);
      return;
    }
    const d = drag.current;
    if (d) {
      const dx = event.clientX - d.x;
      const dy = event.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (!d.moved) return;
      if (d.pan) {
        const t = (d.start.yaw * Math.PI) / 180;
        const wx = -dx / d.start.zoom;
        const wy = dy / (d.start.zoom * Math.max(0.35, Math.cos((d.start.pitch * Math.PI) / 180)));
        setCam({ ...d.start,
          panX: d.start.panX + wx * Math.cos(t) + wy * Math.sin(t),
          panY: d.start.panY - wx * Math.sin(t) + wy * Math.cos(t) });
      } else {
        setCam({ ...d.start, yaw: d.start.yaw + dx * 0.35,
          pitch: clamp(d.start.pitch - dy * 0.3, PITCH_LIMITS) });
      }
      setHover(null);
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;

    const at = groundAt(sx, sy);
    const district = layers ? districtAt(layers, at.lat, at.lon) : null;
    const elev = layers && district ? elevationAt(layers.terrain, at.lat, at.lon) : null;
    setCursor((current) => current && current.district === district
      && Math.abs(current.lat - at.lat) < 1e-4 && Math.abs(current.lon - at.lon) < 1e-4
      ? current : { lat: at.lat, lon: at.lon, district, elev });

    let best: { dist: number; text: string; sub?: string; x: number; y: number; color?: string; lat?: number; lon?: number } | null = null;
    for (const { pin, head } of drawnPins) {
      const dist = Math.hypot(head.x - sx, head.y - sy);
      if (dist < 15 && (!best || dist < best.dist)) {
        best = { dist, text: pin.label, x: head.x, y: head.y, sub: "Ready to dispatch", color: PIN[pin.tone ?? "ready"],
          lat: pin.lat, lon: pin.lon };
      }
    }
    if (!best && show.points) {
      for (const { node, kind, p } of projectedNodes) {
        const dist = Math.hypot(p.x - sx, p.y - sy);
        if (dist < 8 && (!best || dist < best.dist)) {
          best = { dist, text: node.name, x: p.x, y: p.y, color: NODE_COLORS[kind] ?? NODE_COLORS.other,
            sub: [KIND_WORD[kind] ?? node.kind, node.code].filter(Boolean).join(" · "), lat: node.lat, lon: node.lon };
        }
      }
    }
    if (best) {
      const where = layers && best.lat != null && best.lon != null ? districtAt(layers, best.lat, best.lon) : null;
      const metres = layers && best.lat != null && best.lon != null ? Math.round(elevationAt(layers.terrain, best.lat, best.lon)) : null;
      setHover({ x: best.x, y: best.y, text: best.text, sub: best.sub, color: best.color,
        extra: where ? `${where.full} district${metres != null ? ` · ~${metres} m` : ""}` : undefined });
    } else {
      setHover(null);
    }
  };
  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      drag.current = null;
      return true;
    }
    return false;
  };
  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (endPointer(event)) return;
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    if (pickMode) {
      const at = groundAt(sx, sy);
      // The confirm dialog opens on the page, which full screen would hide behind the map.
      if (full) exitFull();
      pickMode.onPick(Number(at.lat.toFixed(6)), Number(at.lon.toFixed(6)));
      return;
    }
    const hit = drawnPins.find(({ head }) => Math.hypot(head.x - sx, head.y - sy) < 15);
    if (hit && onPinClick) onPinClick(hit.pin.key);
  };
  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (pickMode) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const target = zoomAbout(cam, event.shiftKey ? 1 / 1.8 : 1.8, event.clientX - rect.left, event.clientY - rect.top);
    glideTo(target, 520);
  };

  const zoomBy = (factor: number) => glideTo({ zoom: clamp(cam.zoom * factor, ZOOM_LIMITS) });
  const flat = cam.pitch < 8;

  // Keyboard, while the map has focus — and never while typing into an overlay on it.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const el = event.target as HTMLElement;
    if (el.closest("input, textarea, select, [contenteditable='true']")) return;
    const t = (cam.yaw * Math.PI) / 180;
    const stepKm = 60 / cam.zoom;
    const pan = (ex: number, ny: number) => glideTo({
      panX: cam.panX + ex * Math.cos(t) + ny * Math.sin(t),
      panY: cam.panY - ex * Math.sin(t) + ny * Math.cos(t),
    }, 220);
    const actions: Record<string, () => void> = {
      ArrowLeft: () => pan(-stepKm, 0), ArrowRight: () => pan(stepKm, 0),
      ArrowUp: () => pan(0, stepKm), ArrowDown: () => pan(0, -stepKm),
      "+": () => zoomBy(1.4), "=": () => zoomBy(1.4), "-": () => zoomBy(1 / 1.4),
      q: () => glideTo({ yaw: cam.yaw - 20 }, 300), e: () => glideTo({ yaw: cam.yaw + 20 }, 300),
      n: () => glideTo({ yaw: 0 }), f: () => fit(),
    };
    const run = actions[event.key] ?? actions[event.key.toLowerCase()];
    if (run) { event.preventDefault(); run(); }
  };

  const legend = [
    { color: NODE_COLORS.MAIN, label: "Central / main" },
    { color: NODE_COLORS.MDP, label: "MDP" },
    { color: NODE_COLORS.LIP, label: "LIP" },
    { color: PIN.ready, label: "Ready consignment" },
  ];
  const scale = niceScale(cam.zoom, 96);
  const sweepR = originP ? 260 * cam.zoom * originP.ground.scale : 0;
  const glow = inMotion ? undefined : "url(#ap3d-glow)";

  return (
    <div ref={box} tabIndex={0} onKeyDown={onKeyDown} data-moving={inMotion || undefined}
      aria-label="Interactive map of Andhra Pradesh. Arrow keys pan, plus and minus zoom, Q and E turn, N faces north."
      className={`ap3d outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 ${full
        ? "fixed inset-0 z-[70] w-screen overflow-hidden"
        : "relative w-full overflow-hidden rounded-xl border border-line"}`}
      style={{ height, background: "radial-gradient(120% 90% at 18% 0%, #12305f 0%, #081631 46%, #030916 100%)" }}>
      <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute left-0 top-0"
        style={{ width, height }} />

      {/* The scan from the origin belongs to the overview; over a route it competes
          with the one line the screen is about. */}
      {originP && sweepR > 20 && !reduced && !inMotion && !routes.some((route) => route.emphasis === "active") && (
        <div aria-hidden className="pointer-events-none absolute"
          style={{ left: originP.ground.x, top: originP.ground.y, width: sweepR * 2, height: sweepR * 2,
            transform: `translate(-50%, -50%) scaleY(${Math.max(0.12, Math.cos((cam.pitch * Math.PI) / 180)).toFixed(3)})` }}>
          <div className="ap3d-sweep absolute inset-0 rounded-full" />
          <div className="absolute inset-[18%] rounded-full border border-sky-300/10" />
          <div className="absolute inset-[36%] rounded-full border border-sky-300/10" />
        </div>
      )}

      <svg ref={svgRef} width={width} height={height} role="img"
        aria-label={`Map of Andhra Pradesh: ${nodes.length} stocking points, ${routes.length} routes`}
        className={`absolute left-0 top-0 block select-none ${pickMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={(e) => { endPointer(e); drag.current = null; }}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => { setHover(null); setCursor(null); }} onContextMenu={(e) => e.preventDefault()}>
        <defs>
          {/* Beacon beams: bright at the head, fading into the ground. */}
          {(Object.entries(PIN) as [string, string][]).map(([tone, color]) => (
            <linearGradient key={tone} id={`ap3d-beam-${tone}`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor={color} stopOpacity="0.15" />
              <stop offset="1" stopColor={color} stopOpacity="0.95" />
            </linearGradient>
          ))}
          <filter id="ap3d-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          {drawnRoutes.map(({ route, colors }) => (
            <linearGradient key={route.key} id={`ap3d-route-${route.key}`} x1="0" x2="1">
              <stop offset="0" stopColor={colors[0]} />
              <stop offset="1" stopColor={colors[1]} />
            </linearGradient>
          ))}
        </defs>

        {coastPath && (
          <path d={coastPath} fill="none" stroke="#cffafe" strokeWidth="1.6" strokeOpacity="0.75"
            strokeDasharray="1 26" strokeLinecap="round" className="ap3d-coast" pointerEvents="none" />
        )}

        {districtPath && (
          <g pointerEvents="none">
            <path d={districtPath} fill="rgba(125, 211, 252, 0.2)" stroke="#7dd3fc" strokeOpacity="0.4" strokeWidth="6"
              strokeLinejoin="round" />
            <path d={districtPath} fill="none" stroke="#bae6fd" strokeWidth="1.4" strokeLinejoin="round" />
          </g>
        )}

        {drawnRoutes.map(({ route, legs, colors }) => {
          const active = route.emphasis === "active";
          return (
            <g key={route.key} className={onRouteClick ? "cursor-pointer" : undefined}
              onPointerUp={(e) => { if (onRouteClick && !drag.current?.moved) { e.stopPropagation(); onRouteClick(route.key); } }}>
              {legs.map((leg, i) => leg.ret ? (
                <polyline key={i} points={leg.pts} fill="none" stroke={colors[1]}
                  strokeOpacity={active ? 0.45 : 0.18} strokeWidth={active ? 1.6 : 1}
                  strokeDasharray="5 6" />
              ) : (
                <g key={i}>
                  {active && <polyline points={leg.pts} fill="none" stroke={colors[0]}
                    strokeOpacity="0.28" strokeWidth="9" strokeLinecap="round" filter={glow} />}
                  <polyline points={leg.pts} fill="none"
                    stroke={active ? `url(#ap3d-route-${route.key})` : colors[0]}
                    strokeOpacity={active ? 1 : 0.4} strokeWidth={active ? 3.2 : 1.6}
                    strokeLinecap="round" />
                  {active && <polyline points={leg.pts} fill="none" stroke="#fff"
                    strokeOpacity="0.85" strokeWidth="1.4" strokeDasharray="2 16"
                    strokeLinecap="round" className="ap3d-flow" />}
                </g>
              ))}
              {active && route.truckLeg != null && legs[route.truckLeg]?.path && (
                <g>
                  <circle r="9" fill={colors[1]} opacity="0.25">
                    <animateMotion dur="3.4s" repeatCount="indefinite" path={legs[route.truckLeg].path} />
                  </circle>
                  <rect x="-6" y="-4" width="12" height="8" rx="2" fill="#fff" stroke={colors[1]} strokeWidth="1.5">
                    <animateMotion dur="3.4s" repeatCount="indefinite" rotate="auto" path={legs[route.truckLeg].path} />
                  </rect>
                </g>
              )}
            </g>
          );
        })}

        {/* A ready consignment is a beacon, not one more dot: eight hundred stocking
            points share the same few pixels, so it stands up off the ground as a
            glowing beam with a ringed head and a pulse where it stands. */}
        {drawnPins.map(({ pin, base, head }) => {
          const tone = pin.tone ?? "ready";
          const color = PIN[tone];
          const dim = tone === "dim";
          const r = tone === "picked" ? 8.5 : 7.5;
          // The pulse lies on the ground, so it is flattened by the camera's tilt.
          const flat = Math.max(0.25, Math.cos((cam.pitch * Math.PI) / 180));
          // A tapered beam (a thin polygon, so its gradient has a box to run along).
          const w0 = dim ? 1.4 : 2.6;
          const w1 = dim ? 0.6 : 1;
          const beam = `${base.x - w0},${base.y} ${base.x + w0},${base.y} ${head.x + w1},${head.y} ${head.x - w1},${head.y}`;
          return (
            <g key={pin.key} className={onPinClick ? "cursor-pointer" : undefined}>
              {!dim && (
                <ellipse cx={base.x} cy={base.y} rx="9" ry={9 * flat} fill="none" stroke={color}
                  strokeWidth="2" className="ap3d-beacon" />
              )}
              <ellipse cx={base.x} cy={base.y} rx="4.5" ry={4.5 * flat} fill={color} opacity={dim ? 0.25 : 0.55} />
              <polygon points={beam} fill={`url(#ap3d-beam-${tone})`} opacity={dim ? 0.45 : 1} />
              {!dim && <circle cx={head.x} cy={head.y} r={r + 8} fill={color} opacity="0.3" filter={glow} />}
              {!dim && (
                <circle cx={head.x} cy={head.y} r={r + 3} fill="none" stroke={color} strokeWidth="1.5"
                  className="ap3d-beacon" />
              )}
              <circle cx={head.x} cy={head.y} r={r} fill={color} stroke={dim ? "#04101f" : "#ffffff"}
                strokeWidth={dim ? 1.2 : 2} />
              {!dim && <circle cx={head.x} cy={head.y} r={r * 0.38} fill="#ffffff" opacity="0.9" />}
            </g>
          );
        })}

        {drawnRoutes.filter(({ route }) => route.emphasis === "active").map(({ route, stops }) => (
          <g key={`stops-${route.key}`}>
            {stops.map(({ stop, p }) => {
              const color = STOP[stop.state ?? "planned"];
              return (
                <g key={stop.key}>
                  <circle cx={p.x} cy={p.y} r="12" fill={color} opacity="0.18" />
                  <circle cx={p.x} cy={p.y} r="8.5" fill="#04101f" stroke={color} strokeWidth="2.2" />
                  <text x={p.x} y={p.y + 3.4} textAnchor="middle" fontSize="9.5" fontWeight="700"
                    fill="#fff">{stop.state === "acknowledged" ? "✓" : stop.sequence}</text>
                  <text x={p.x + 13} y={p.y - 9} fontSize="11" fontWeight="600" fill="#e2ecff"
                    stroke="#04101f" strokeWidth="3" paintOrder="stroke">
                    {stop.label.length > 34 ? `${stop.label.slice(0, 33)}…` : stop.label}
                    {stop.count && stop.count > 1 ? ` · ${stop.count}` : ""}
                  </text>
                </g>
              );
            })}
          </g>
        ))}

        {originP && (
          <g pointerEvents="none">
            <line x1={originP.ground.x} y1={originP.ground.y} x2={originP.head.x} y2={originP.head.y}
              stroke="#fbbf24" strokeWidth="2.4" strokeOpacity="0.85" />
            <circle cx={originP.ground.x} cy={originP.ground.y} r="6" fill="none" stroke="#fbbf24" strokeWidth="1.5">
              <animate attributeName="r" values="6;26;6" dur="2.6s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.9;0;0.9" dur="2.6s" repeatCount="indefinite" />
            </circle>
            <circle cx={originP.head.x} cy={originP.head.y} r="7" fill="#fbbf24" stroke="#fff"
              strokeWidth="2" filter={glow} />
            {originLabel && (
              <text x={originLabel.x} y={originP.head.y - 6} textAnchor={originLabel.anchor} fontSize="11.5" fontWeight="700"
                fill="#fde68a" stroke="#04101f" strokeWidth="3" paintOrder="stroke">
                {originLabel.text}
              </text>
            )}
          </g>
        )}

        {hover && (
          <circle cx={hover.x} cy={hover.y} r="7" fill="none" stroke={hover.color ?? "#fff"} strokeWidth="1.6"
            pointerEvents="none" className="ap3d-ping" />
        )}
      </svg>

      {hover && (
        <div className="pointer-events-none absolute z-20 max-w-[280px] -translate-x-1/2 -translate-y-full overflow-hidden rounded-lg border border-white/15 bg-slate-950/90 text-[11px] text-slate-100 shadow-xl backdrop-blur"
          style={{ left: hover.x, top: hover.y - 12 }}>
          <div className="h-0.5" style={{ background: hover.color ?? "#7dd3fc" }} />
          <div className="px-2.5 py-1.5">
            <div className="font-semibold leading-snug">{hover.text}</div>
            {hover.sub && <div className="text-slate-400">{hover.sub}</div>}
            {hover.extra && <div className="mt-0.5 text-sky-200/80">{hover.extra}</div>}
          </div>
        </div>
      )}

      {(title || subtitle || badge) && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4 pr-16">
          <div className="min-w-0 text-white">
            {title && (
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.22em] text-sky-300">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75 motion-safe:animate-ping" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-300" />
                </span>
                {title}
              </div>
            )}
            {subtitle && <div className="mt-1 truncate text-sm font-semibold">{subtitle}</div>}
          </div>
          {badge && <div className="pointer-events-auto shrink-0">{badge}</div>}
        </div>
      )}

      <div className="absolute right-3 top-3 flex flex-col items-center gap-1.5">
        <button type="button" onClick={() => glideTo({ yaw: 0 })} title="Face north (N)" aria-label="Face north"
          className="group relative flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-slate-950/60 backdrop-blur transition hover:border-sky-300/50">
          <svg viewBox="0 0 44 44" className="h-11 w-11" aria-hidden>
            <circle cx="22" cy="22" r="17" fill="none" stroke="rgba(125,211,252,0.25)" strokeDasharray="1 3.2" />
            <g transform={`rotate(${-cam.yaw} 22 22)`}>
              <path d="M22 7 L26 22 L22 20 L18 22 Z" fill="#f87171" />
              <path d="M22 37 L26 22 L22 24 L18 22 Z" fill="rgba(226,236,255,0.55)" />
              <text x="22" y="6.3" textAnchor="middle" fontSize="6" fontWeight="700" fill="#fecaca">N</text>
            </g>
          </svg>
          <span className="pointer-events-none absolute -bottom-1 rounded bg-slate-950/80 px-1 text-[8px] font-semibold tabular-nums text-sky-200">
            {Math.round(cam.pitch)}°
          </span>
        </button>
        {[
          { icon: full ? Shrink : Expand, label: full ? "Exit full screen (Esc)" : "Full screen", run: () => { void toggleFull(); }, on: full },
          { icon: Plus, label: "Zoom in (+)", run: () => zoomBy(1.4) },
          { icon: Minus, label: "Zoom out (−)", run: () => zoomBy(1 / 1.4) },
          { icon: LocateFixed, label: "Fit to route (F)", run: () => fit() },
          flat
            ? { icon: Box, label: "3D view", run: () => fit(50, homeYaw) }
            : { icon: Square, label: "Map view (top down)", run: () => fit(0, 0) },
          { icon: Orbit, label: orbit ? "Stop orbiting" : "Orbit", run: () => setOrbit((on) => !on), on: orbit },
          { icon: Layers, label: "Layers", run: () => setPanel((open) => !open), on: panel },
        ].map(({ icon: Icon, label, run, on }) => (
          <button key={label} type="button" title={label} aria-label={label} onClick={run} aria-pressed={on}
            className={`flex h-11 w-11 items-center justify-center rounded-lg border backdrop-blur transition sm:h-9 sm:w-9 ${
              on ? "border-sky-300/60 bg-sky-400/25 text-white shadow-[0_0_14px_rgba(56,189,248,0.35)]"
                : "border-white/15 bg-slate-950/55 text-slate-200 hover:border-sky-300/40 hover:bg-slate-900/80"}`}>
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>

      {panel && (
        <div className="absolute right-16 top-3 z-30 w-60 rounded-xl border border-sky-300/20 bg-slate-950/85 p-2 text-slate-100 shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
            <span className="text-[10px] font-semibold uppercase tracking-[.2em] text-sky-300">Map layers</span>
            <button type="button" onClick={() => setPanel(false)} aria-label="Close layers"
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {LAYER_ROWS.map((row) => {
            const on = show[row.key];
            return (
              <button key={row.key} type="button" role="switch" aria-checked={on}
                onClick={() => setShow((current) => ({ ...current, [row.key]: !current[row.key] }))}
                className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/5">
                <span className={`relative h-4 w-7 shrink-0 rounded-full transition ${on ? "bg-sky-400/80" : "bg-slate-700"}`}>
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${on ? "left-3.5" : "left-0.5"}`} />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">{row.label}</span>
                  <span className="block truncate text-[10px] text-slate-400">{row.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {pickMode && (
        <div className="absolute inset-x-4 top-16 mx-auto flex max-w-md items-center gap-2 rounded-lg border border-amber-300/40 bg-amber-400/15 px-3 py-2 text-xs text-amber-50 backdrop-blur sm:right-16">
          <Crosshair className="h-4 w-4 shrink-0" />
          <span className="flex-1">{pickMode.label}</span>
          {pickMode.onCancel && (
            <button type="button" onClick={pickMode.onCancel} aria-label="Cancel pinning"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-white/10 sm:h-7 sm:w-7">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {children}

      {cursor && (
        <div className="pointer-events-none absolute bottom-12 left-1/2 hidden -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-sky-300/15 bg-slate-950/70 px-3 py-1 text-[10px] tabular-nums text-slate-300 backdrop-blur sm:flex">
          <Crosshair className="h-3 w-3 text-sky-300" />
          <span>{formatLatLon(cursor.lat, cursor.lon)}</span>
          {cursor.district ? (
            <>
              <span className="text-slate-600">|</span>
              <span className="font-semibold text-sky-100">{cursor.district.full}</span>
              {cursor.elev != null && (
                <>
                  <span className="text-slate-600">|</span>
                  <Mountain className="h-3 w-3 text-sky-300" />
                  <span>~{Math.round(cursor.elev)} m</span>
                </>
              )}
            </>
          ) : layers ? <span className="text-slate-500">· outside Andhra Pradesh</span> : null}
        </div>
      )}

      {!layers && (
        <div className="pointer-events-none absolute bottom-12 left-3 rounded-full bg-slate-950/60 px-2.5 py-1 text-[10px] text-sky-200/80">
          <span className="motion-safe:animate-pulse">Rendering terrain…</span>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-slate-950/60 px-2.5 py-1.5 text-[10px] text-slate-300 backdrop-blur sm:max-w-[60%]">
        {legend.map((row) => (
          <span key={row.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: row.color, boxShadow: `0 0 6px ${row.color}` }} />{row.label}
          </span>
        ))}
        {layers && show.water && (
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-sky-300" />River</span>
        )}
        {layers && show.districts && (
          <span className="flex items-center gap-1.5"><span className="w-3 border-t border-dashed border-slate-300/70" />District</span>
        )}
        {scale.km > 0 && (
          <span className="flex items-center gap-1.5 tabular-nums">
            <span className="h-1.5 border-x border-b border-slate-300/80" style={{ width: scale.px }} />
            {scale.km} km
          </span>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 hidden text-right text-[9px] leading-tight text-slate-400 sm:block">
        {footer ?? <>Drag to orbit · Shift+drag to pan · scroll or pinch to zoom · double-click to dive<br />
          Districts 2022 · geoBoundaries · © OpenStreetMap contributors · SRTM relief · points: warehouse masters</>}
      </div>
      <style>{`
.ap3d-flow{animation:ap3d-flow 1.1s linear infinite}
@keyframes ap3d-flow{to{stroke-dashoffset:-18}}
.ap3d-coast{animation:ap3d-coast 9s linear infinite}
@keyframes ap3d-coast{to{stroke-dashoffset:-270}}
.ap3d-ping{animation:ap3d-ping 1.4s ease-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes ap3d-ping{0%{opacity:1;transform:scale(.7)}100%{opacity:0;transform:scale(2.1)}}
.ap3d-sweep{background:conic-gradient(from 0deg,rgba(56,189,248,0) 0deg,rgba(56,189,248,0) 300deg,rgba(56,189,248,.07) 350deg,rgba(186,230,253,.2) 360deg);
  -webkit-mask-image:radial-gradient(circle,#000 0 58%,transparent 71%);mask-image:radial-gradient(circle,#000 0 58%,transparent 71%);
  mix-blend-mode:screen;animation:ap3d-sweep 7s linear infinite}
@keyframes ap3d-sweep{to{transform:rotate(360deg)}}
.ap3d-beacon{animation:ap3d-beacon 2.2s ease-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes ap3d-beacon{0%{opacity:.95;transform:scale(.6)}100%{opacity:0;transform:scale(2.6)}}
.ap3d[data-moving] .backdrop-blur,.ap3d[data-moving] .backdrop-blur-md{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
@media (prefers-reduced-motion: reduce){.ap3d-flow,.ap3d-coast,.ap3d-ping,.ap3d-sweep,.ap3d-beacon{animation:none}}
`}</style>
    </div>
  );
}
