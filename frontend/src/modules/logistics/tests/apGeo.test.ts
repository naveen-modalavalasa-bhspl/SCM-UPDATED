import { describe, expect, it } from "vitest";
import {
  AP_OUTLINE, AP_OUTLINE_WORLD, decodePolyline, frame, insideAp, parseCoordinates, project, toLatLon,
  toWorld, unproject, type Camera,
} from "../components/apGeo";
import { stopMapState, tripProgress, truckLeg } from "../components/tripCopy";

const CAM: Camera = { yaw: -12, pitch: 52, zoom: 1.3, panX: 20, panY: -40, width: 900, height: 560 };
const VIJAYAWADA = { lat: 16.5062, lon: 80.648 };

describe("the Andhra Pradesh outline", () => {
  it("is a closed ring around the state's real cities", () => {
    expect(AP_OUTLINE[0]).toEqual(AP_OUTLINE[AP_OUTLINE.length - 1]);
    expect(insideAp(VIJAYAWADA.lat, VIJAYAWADA.lon)).toBe(true);
    expect(insideAp(17.6868, 83.2185)).toBe(true);    // Visakhapatnam
    expect(insideAp(13.6288, 79.4192)).toBe(true);    // Tirupati
    expect(insideAp(17.385, 78.4867)).toBe(false);    // Hyderabad — Telangana
    expect(insideAp(13.0827, 80.2707)).toBe(false);   // Chennai — Tamil Nadu
  });

  it("leaves Yanam out — Puducherry's enclave inside Kakinada", () => {
    expect(insideAp(16.7333, 82.2167)).toBe(false);   // Yanam
    expect(insideAp(16.9891, 82.2475)).toBe(true);    // Kakinada, next door
  });

  it("decodes Google's encoded polylines", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 1e5))
      .toEqual([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  });
});

describe("the camera", () => {
  it("round-trips latitude and longitude through world km", () => {
    const [x, y] = toWorld(VIJAYAWADA.lat, VIJAYAWADA.lon);
    const back = toLatLon(x, y);
    expect(back.lat).toBeCloseTo(VIJAYAWADA.lat, 6);
    expect(back.lon).toBeCloseTo(VIJAYAWADA.lon, 6);
  });

  it("puts a clicked ground point back where it was drawn", () => {
    for (const cam of [CAM, { ...CAM, pitch: 0, yaw: 0 }, { ...CAM, pitch: 68, yaw: 140, zoom: 4 }]) {
      const [x, y] = toWorld(VIJAYAWADA.lat, VIJAYAWADA.lon);
      const drawn = project(cam, [x, y, 0]);
      const picked = unproject(cam, drawn.x, drawn.y);
      expect(picked.lat).toBeCloseTo(VIJAYAWADA.lat, 4);
      expect(picked.lon).toBeCloseTo(VIJAYAWADA.lon, 4);
    }
  });

  it("puts a point drawn above the ground back where it was, given its height", () => {
    const [x, y] = toWorld(VIJAYAWADA.lat, VIJAYAWADA.lon);
    const drawn = project(CAM, [x, y, 17]);
    const picked = unproject(CAM, drawn.x, drawn.y, 17);
    expect(picked.lat).toBeCloseTo(VIJAYAWADA.lat, 4);
    expect(picked.lon).toBeCloseTo(VIJAYAWADA.lon, 4);
  });

  it("draws the far side of a tilted map smaller than the near side", () => {
    const north = project(CAM, [0, 300, 0]);
    const south = project(CAM, [0, -300, 0]);
    expect(north.scale).toBeLessThan(south.scale);
    expect(north.depth).toBeGreaterThan(south.depth);
  });

  it.each([0, -24, 60])("frames the whole state inside the canvas at yaw %i", (yaw) => {
    const view = frame(AP_OUTLINE_WORLD, 900, 560, 52, 0.08, yaw);
    const cam = { ...CAM, ...view, yaw, pitch: 52 };
    for (const [x, y] of AP_OUTLINE_WORLD) {
      const p = project(cam, [x, y, 0]);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(900);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(560);
    }
  });
});

describe("pasting a location", () => {
  it("reads a plain pair, a Google Maps link and degrees-minutes-seconds", () => {
    expect(parseCoordinates("16.5062, 80.6480")).toEqual({ lat: 16.5062, lon: 80.648 });
    expect(parseCoordinates("https://www.google.com/maps/@16.5062,80.648,15z")).toEqual({ lat: 16.5062, lon: 80.648 });
    const dms = parseCoordinates(`16°30'22"N 80°38'53"E`);
    expect(dms?.lat).toBeCloseTo(16.506, 3);
    expect(dms?.lon).toBeCloseTo(80.648, 3);
  });

  it("takes a place link's pin, not the centre of the map view", () => {
    const link = "https://www.google.com/maps/place/16%C2%B030'20.8%22N+80%C2%B042'06.2%22E/"
      + "@16.5057752,80.6991419,17z/data=!3m1!4b1!4m4!3m3!8m2!3d16.5057752!4d80.7017168?hl=en";
    expect(parseCoordinates(link)).toEqual({ lat: 16.5057752, lon: 80.7017168 });
    const dms = parseCoordinates(`16°30'20.8"N 80°42'06.2"E`);
    expect(dms?.lat).toBeCloseTo(16.505778, 5);
    expect(dms?.lon).toBeCloseTo(80.701722, 5);
  });

  it("refuses what is not a point in India", () => {
    expect(parseCoordinates("")).toBeNull();
    expect(parseCoordinates("hello")).toBeNull();
    expect(parseCoordinates("51.5, -0.12")).toBeNull();
  });
});

describe("a trip's progress", () => {
  const stops = (...statuses: string[]) => statuses.map((status, index) => ({
    id: index + 1, sequence: index + 1, status,
  })) as never;

  it("counts delivered and signed off the stops themselves", () => {
    expect(tripProgress({ stops: stops("ACKNOWLEDGED", "DELIVERED", "IN_TRANSIT") }))
      .toEqual({ total: 3, delivered: 2, signed: 1 });
  });

  it("puts the truck on the leg to the first stop still on it", () => {
    expect(truckLeg({ status: "IN_TRANSIT", stops: stops("IN_TRANSIT", "IN_TRANSIT") })).toBe(0);
    expect(truckLeg({ status: "PARTIALLY_DELIVERED", stops: stops("DELIVERED", "IN_TRANSIT") })).toBe(1);
    expect(truckLeg({ status: "PLANNED", stops: stops("PLANNED") })).toBeNull();
    expect(truckLeg({ status: "DELIVERED", stops: stops("DELIVERED") })).toBeNull();
  });

  it("maps stop statuses onto the map's four states", () => {
    expect(stopMapState("ACKNOWLEDGED")).toBe("acknowledged");
    expect(stopMapState("DELIVERED")).toBe("delivered");
    expect(stopMapState("IN_TRANSIT")).toBe("transit");
    expect(stopMapState("PLANNED")).toBe("planned");
  });
});
