"""Road distances between map points, for the Smart Load Planner.

The planner used to measure every leg as the straight line times a road factor. That
is honest for comparing one plan with another and wrong in the ways that matter on the
ground: a ghat road, a river with one bridge, a reservoir the highway goes round. So a
distance is now asked of a ROUTING SERVICE when one is configured, and estimated only
when it is not — and every figure says which it was.

How a matrix is built, cheapest first:

1. **The cache** (`lgs_road_distances`). A routed pair is asked for once and kept for
   `ROUTING_CACHE_DAYS`. Keyed on coordinates rounded to five places, so a point that
   is re-pinned is a NEW pair and an old answer can never be served for it.
2. **The routing service** (`ROUTING_OSRM_URL`, OSRM's `/table` API) for whatever the
   cache does not hold, in blocks, inside one overall deadline. Written back to the
   cache in its OWN session: the planner may be holding row locks on consignments, and
   committing its session to save a cache row would release them.
3. **An estimate** for anything still missing — straight line times a road factor.
   Where enough routed pairs exist, the factor is CALIBRATED from them (the median of
   road km over straight km), because a fixed 1.22 is a guess about roads and the
   cache is a measurement of them.

Reliability rules that fail SILENTLY if narrowed:

* Nothing here may fail a planning request. A service that is down, slow, or answers
  nonsense yields estimates, logged once, and the next request does not wait on it
  again for `_BREAKER_SECONDS` (a per-process circuit breaker).
* A pair the service could not route (`null` in the table — an island, a point in the
  sea) is NOT cached as zero. Zero would read as "right next door".
* The basis travels with the numbers (`DistanceMatrix.basis`): ROAD, MIXED or
  ESTIMATE. A plan costed on estimates must never be shown as a routed one.
"""
from __future__ import annotations

import asyncio
import logging
import math
import statistics
import time
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

import httpx
from sqlalchemy import select, tuple_
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import SessionLocal
from app.modules.logistics.models import RoadDistance
from app.shared.models.base import utcnow

logger = logging.getLogger(__name__)

EARTH_KM = 6371.0088

#: How many points go into one `/table` request, per side. OSRM's stock
#: `--max-table-size` is 100 locations; two blocks of 40 stay well under it.
BLOCK = 40
#: After a failure, how long the service is left alone before it is tried again.
_BREAKER_SECONDS = 120.0
_breaker_open_until = 0.0

#: Calibration needs this many routed pairs before it is trusted over the site's
#: configured factor, and only pairs at least this far apart count — two points in the
#: same town have a ratio dominated by one-way streets.
CALIBRATION_MIN_PAIRS = 20
CALIBRATION_MIN_KM = 5.0
_CALIBRATION_TTL = 600.0
_calibration: tuple[float, float | None, int] = (0.0, None, 0)   # (when, factor, n)

Point = tuple[float, float]


def point_key(point: Point) -> Point:
    """A coordinate as the cache knows it: five decimals, about a metre."""
    return (round(float(point[0]), 5), round(float(point[1]), 5))


def pair_key(a: Point, b: Point) -> str:
    a, b = point_key(a), point_key(b)
    return f"{a[0]:.5f},{a[1]:.5f}>{b[0]:.5f},{b[1]:.5f}"


def straight_km(a: Point, b: Point) -> float:
    """Great-circle kilometres between two points."""
    lat1, lon1, lat2, lon2 = map(math.radians, (float(a[0]), float(a[1]),
                                                float(b[0]), float(b[1])))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return EARTH_KM * 2 * math.asin(min(1.0, math.sqrt(h)))


def routing_configured() -> bool:
    return bool(settings.ROUTING_OSRM_URL)


def _source() -> str:
    return f"OSRM:{settings.ROUTING_PROFILE}"[:40]


@dataclass
class DistanceMatrix:
    """Kilometres between the points of one plan. Callable: `matrix(a, b)`.

    Routed where the road is known, estimated where it is not. Directional where the
    service answered both ways; the reverse of a routed leg is preferred over an
    estimate, because the road back is nearly always the road there.
    """
    road_factor: float
    road: dict[tuple[Point, Point], float] = field(default_factory=dict)
    #: Where the factor for estimates came from: SITE (the planner policy) or
    #: CALIBRATED (learnt from routed pairs).
    factor_source: str = "SITE"
    calibrated_pairs: int = 0
    service: str | None = None
    #: Set when the routing service was configured but could not be reached.
    service_error: str | None = None
    used_road: int = 0
    used_estimate: int = 0
    _memo: dict = field(default_factory=dict, repr=False)

    def routed(self, a: Point, b: Point) -> float | None:
        a, b = point_key(a), point_key(b)
        if a == b:
            return 0.0
        value = self.road.get((a, b))
        return value if value is not None else self.road.get((b, a))

    def __call__(self, a: Point, b: Point) -> float:
        key = (point_key(a), point_key(b))
        cached = self._memo.get(key)
        if cached is not None:
            return cached
        value = self.routed(a, b)
        if value is None:
            value = straight_km(a, b) * self.road_factor
        self._memo[key] = value
        return value

    def leg_basis(self, a: Point, b: Point) -> str:
        return "ROAD" if self.routed(a, b) is not None else "ESTIMATE"

    def basis_of(self, route: list[Point]) -> str:
        """ROAD, MIXED or ESTIMATE for the legs of one route, in order."""
        legs = [self.leg_basis(route[i], route[i + 1]) for i in range(len(route) - 1)]
        if not legs:
            return "ROAD" if self.road else "ESTIMATE"
        if all(leg == "ROAD" for leg in legs):
            return "ROAD"
        return "MIXED" if any(leg == "ROAD" for leg in legs) else "ESTIMATE"

    def describe(self) -> dict:
        """What the screen says about where its kilometres came from."""
        if self.road:
            if self.service_error:
                text = (f"Road km from {self.service or 'the routing service'} where "
                        "already known; the service is unreachable, so the rest are "
                        f"estimated (straight line × {self.road_factor:.2f})")
            else:
                text = f"Road km routed by {self.service or 'the routing service'}"
        elif self.service_error:
            text = ("Estimated road km — the routing service is unreachable; straight "
                    f"line × {self.road_factor:.2f}")
        else:
            text = f"Estimated road km — straight line × {self.road_factor:.2f}"
        if self.factor_source == "CALIBRATED":
            text += f" (factor learnt from {self.calibrated_pairs} routed pairs)"
        return {
            "routing_configured": routing_configured(),
            "service": self.service,
            "service_error": self.service_error,
            "routed_pairs": len(self.road),
            "estimate_factor": round(self.road_factor, 3),
            "estimate_factor_source": self.factor_source,
            "calibrated_pairs": self.calibrated_pairs,
            "text": text,
        }


# --------------------------------------------------------------------------- #
#  The cache
# --------------------------------------------------------------------------- #

async def _cached(db: AsyncSession, points: list[Point]) -> dict[tuple[Point, Point], float]:
    """Every fresh cached pair whose both ends are among `points`. One query."""
    if len(points) < 2:
        return {}
    keys = [(Decimal(f"{lat:.5f}"), Decimal(f"{lon:.5f}")) for lat, lon in points]
    fresh_after = utcnow() - timedelta(days=max(1, settings.ROUTING_CACHE_DAYS))
    rows = (await db.execute(
        select(RoadDistance.from_lat, RoadDistance.from_lon, RoadDistance.to_lat,
               RoadDistance.to_lon, RoadDistance.distance_km)
        .where(tuple_(RoadDistance.from_lat, RoadDistance.from_lon).in_(keys),
               tuple_(RoadDistance.to_lat, RoadDistance.to_lon).in_(keys),
               RoadDistance.fetched_at >= fresh_after)
    )).all()
    return {((float(a), float(b)), (float(c), float(d))): float(km)
            for a, b, c, d, km in rows}


async def _store(found: dict[tuple[Point, Point], tuple[float, float | None]]) -> None:
    """Write routed pairs to the cache in a session of its own. Never raises."""
    if not found:
        return
    now = utcnow()
    rows = [{
        "pair_key": pair_key(a, b), "from_lat": a[0], "from_lon": a[1],
        "to_lat": b[0], "to_lon": b[1], "distance_km": round(km, 3),
        "duration_min": round(minutes, 2) if minutes is not None else None,
        "source": _source(), "fetched_at": now,
    } for (a, b), (km, minutes) in found.items()]
    try:
        async with SessionLocal() as session:
            for start in range(0, len(rows), 500):
                stmt = mysql_insert(RoadDistance).values(rows[start:start + 500])
                stmt = stmt.on_duplicate_key_update(
                    distance_km=stmt.inserted.distance_km,
                    duration_min=stmt.inserted.duration_min,
                    source=stmt.inserted.source, fetched_at=stmt.inserted.fetched_at)
                await session.execute(stmt)
            await session.commit()
    except Exception:   # a cache that cannot be written is a slower planner, not a broken one
        logger.exception("Could not cache %d road distances", len(rows))


# --------------------------------------------------------------------------- #
#  The routing service
# --------------------------------------------------------------------------- #

async def _osrm_block(client: httpx.AsyncClient, sources: list[Point],
                      targets: list[Point]) -> dict[tuple[Point, Point], tuple[float, float | None]]:
    """One `/table` call: every source to every target."""
    coords = list(dict.fromkeys([*sources, *targets]))
    index = {point: i for i, point in enumerate(coords)}
    path = ";".join(f"{lon:.5f},{lat:.5f}" for lat, lon in coords)
    url = (f"{settings.ROUTING_OSRM_URL.rstrip('/')}/table/v1/"
           f"{settings.ROUTING_PROFILE}/{path}")
    response = await client.get(url, params={
        "sources": ";".join(str(index[p]) for p in sources),
        "destinations": ";".join(str(index[p]) for p in targets),
        "annotations": "distance,duration",
    })
    response.raise_for_status()
    body = response.json()
    if body.get("code") != "Ok":
        raise RuntimeError(f"routing service answered {body.get('code')}: "
                           f"{body.get('message', '')}"[:200])
    distances = body.get("distances") or []
    durations = body.get("durations") or []
    out: dict[tuple[Point, Point], tuple[float, float | None]] = {}
    for i, source in enumerate(sources):
        for j, target in enumerate(targets):
            if source == target:
                continue
            try:
                metres = distances[i][j]
            except (IndexError, TypeError):
                metres = None
            # null = no route between them. Left missing, so it is estimated and says
            # so — never cached as a zero that reads as "next door".
            if metres is None or not math.isfinite(float(metres)) or float(metres) < 0:
                continue
            try:
                seconds = durations[i][j]
            except (IndexError, TypeError):
                seconds = None
            out[(source, target)] = (float(metres) / 1000.0,
                                     float(seconds) / 60.0 if seconds is not None else None)
    return out


async def _fetch(missing: set[tuple[Point, Point]]) -> tuple[dict, str | None]:
    """Ask the service for the missing pairs, in blocks, inside one deadline."""
    global _breaker_open_until
    if not missing or not routing_configured():
        return {}, None
    if time.monotonic() < _breaker_open_until:
        return {}, "unavailable (recent failure; retried shortly)"

    sources = sorted({a for a, _ in missing})
    targets = sorted({b for _, b in missing})
    found: dict = {}
    deadline = time.monotonic() + max(1.0, settings.ROUTING_TIMEOUT_SECONDS)
    try:
        async with httpx.AsyncClient(
                timeout=max(1.0, settings.ROUTING_TIMEOUT_SECONDS),
                headers={"User-Agent": "SCM-ERP-Load-Planner/1.0"}) as client:
            for s in range(0, len(sources), BLOCK):
                src = sources[s:s + BLOCK]
                for t in range(0, len(targets), BLOCK):
                    dst = targets[t:t + BLOCK]
                    if not any((a, b) in missing for a in src for b in dst):
                        continue
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("routing deadline passed")
                    found.update(await asyncio.wait_for(
                        _osrm_block(client, src, dst), timeout=remaining))
    except Exception as exc:  # noqa: BLE001 — every failure is an estimate, never an error
        _breaker_open_until = time.monotonic() + _BREAKER_SECONDS
        logger.warning("Road routing failed (%s); %d of %d pairs estimated instead",
                       exc, len(missing) - len(found), len(missing))
        return found, "unreachable"
    return found, None


# --------------------------------------------------------------------------- #
#  Calibration
# --------------------------------------------------------------------------- #

async def calibrated_factor(db: AsyncSession) -> tuple[float | None, int]:
    """The median road/straight ratio over recently routed pairs, or None.

    Cached per process for ten minutes: it is a property of the region's roads, not
    of any one plan, and moves slowly as the cache fills.
    """
    global _calibration
    when, factor, count = _calibration
    if time.monotonic() - when < _CALIBRATION_TTL:
        return factor, count
    rows = (await db.execute(
        select(RoadDistance.from_lat, RoadDistance.from_lon, RoadDistance.to_lat,
               RoadDistance.to_lon, RoadDistance.distance_km)
        .order_by(RoadDistance.id.desc()).limit(3000))).all()
    ratios = []
    for a, b, c, d, km in rows:
        direct = straight_km((float(a), float(b)), (float(c), float(d)))
        if direct >= CALIBRATION_MIN_KM and float(km) > 0:
            ratios.append(float(km) / direct)
    factor = None
    if len(ratios) >= CALIBRATION_MIN_PAIRS:
        factor = min(3.0, max(1.0, statistics.median(ratios)))
    _calibration = (time.monotonic(), factor, len(ratios))
    return factor, len(ratios)


# --------------------------------------------------------------------------- #
#  The one entry point
# --------------------------------------------------------------------------- #

async def build_matrix(db: AsyncSession, points: list[Point], *, road_factor: float,
                       factor_pinned: bool = False, fetch: bool = True) -> DistanceMatrix:
    """Distances between every pair of `points`, routed where possible.

    `factor_pinned` is true when the desk typed a road factor for this run: their
    number is then used for the estimates, never overridden by calibration.
    `fetch=False` reads the cache only — for paths that must not wait on a network.
    """
    unique = list(dict.fromkeys(point_key(p) for p in points))
    matrix = DistanceMatrix(road_factor=road_factor,
                            service=_source() if routing_configured() else None)
    try:
        matrix.road = await _cached(db, unique)
    except Exception:
        logger.exception("Road distance cache unreadable; estimating")
        matrix.road = {}
    if fetch and routing_configured():
        wanted = {(a, b) for a in unique for b in unique if a != b}
        missing = {pair for pair in wanted if pair not in matrix.road}
        if missing:
            found, error = await _fetch(missing)
            matrix.service_error = error
            if found:
                matrix.road.update({pair: km for pair, (km, _) in found.items()})
                await _store(found)
    if not factor_pinned:
        try:
            factor, count = await calibrated_factor(db)
        except Exception:
            logger.exception("Could not calibrate the road factor")
            factor, count = None, 0
        if factor is not None:
            matrix.road_factor = factor
            matrix.factor_source = "CALIBRATED"
            matrix.calibrated_pairs = count
    return matrix


def estimate_matrix(road_factor: float) -> DistanceMatrix:
    """No database, no network: the straight-line estimate. For pure callers."""
    return DistanceMatrix(road_factor=road_factor)
