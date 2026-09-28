"""Offline Andhra Pradesh locality matching for warehouse map coordinates.

Warehouse names are operational labels, not postal addresses. Sending them to a
public geocoder would leak internal master data and make the planner depend on an
external service at request time. This module downloads two public GeoNames files
once, keeps only Andhra Pradesh, and matches locally:

* the **gazetteer** (`export/dump/IN.zip`): populated places, with their aliases and
  the district (admin2) each sits in;
* the **postal directory** (`export/zip/IN.zip`): every post office, which is where
  most villages that host a PHC actually appear by name.

GeoNames data: https://download.geonames.org/export/ (CC BY 4.0).

Why a match is refused rather than guessed — and each of these fails SILENTLY if
loosened, by putting a truck's stop in the wrong village:

* **The district is a constraint, not a hint.** Telugu place names repeat across the
  state (there are dozens of Kothapallis). HCM names each office's district in the
  2022 (and later) scheme; GeoNames mixes that with the older thirteen; the postal
  directory is entirely the older thirteen. `DISTRICT_ACCEPTS` is the bridge, and a
  candidate outside the office's district is never auto-accepted.
* **Two same-named places in one district are one answer only if they are close.**
  GeoNames often carries a village twice (the village and its mandal headquarters);
  within `CLUSTER_KM` that is one place. Farther apart it is two, and it is left for
  a person to choose (`candidates`).
* **Spelling is folded, not fuzzed wide.** "Cheedikada", "Chīdikāda" and
  "Chidikada" are one name; `phonetic_key` folds the transliteration variants Telugu
  names come in (aspirates, doubled consonants, long vowels, -palle/-palli) so they
  meet EXACTLY. The fuzzy fallback on top of that is deliberately tight.
"""
from __future__ import annotations

import asyncio
import difflib
import math
import os
import re
import unicodedata
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import httpx

DATA_URL = "https://download.geonames.org/export/dump/IN.zip"
DATA_FILE = Path(__file__).resolve().parents[3] / "var" / "geodata" / "IN.zip"
ADMIN2_URL = "https://download.geonames.org/export/dump/admin2Codes.txt"
ADMIN2_FILE = DATA_FILE.with_name("admin2Codes.txt")
POSTAL_URL = "https://download.geonames.org/export/zip/IN.zip"
POSTAL_FILE = DATA_FILE.with_name("postal_IN.zip")
AP_ADMIN1 = "02"

#: Bumped whenever the matcher changes in a way that could place a point it once
#: could not. `trips.prepare_map_network` re-tries every unresolved point once per
#: version, so an improvement reaches the existing master without anyone asking.
GAZETTEER_VERSION = "2026-09-28.5"

MIN_CONFIDENCE = 0.86
#: The tightest the fuzzy fallback accepts, on PHONETIC keys (after folding).
FUZZY_MIN = 0.9
#: ...and when the candidate also sits in the office's own MANDAL. Two independent
#: facts agreeing — a near-identical name inside the same mandal — is stronger
#: evidence than a closer spelling anywhere in a district of thirty mandals.
FUZZY_MIN_WITH_MANDAL = 0.85
#: How much the best fuzzy candidate must beat the best DIFFERENT place by.
FUZZY_MARGIN = 0.04
#: Same-named candidates within this distance of each other are one place.
CLUSTER_KM = 15.0
#: How many trigram-nearest places the fuzzy fallback compares in full.
_FUZZY_SHORTLIST = 60
#: A place outside HCM's district is a BORDER case only within this distance of a
#: place that is in it. Mandal names repeat across districts (there is a Gudur mandal
#: in Kurnool and another in Tirupati), so a mandal match alone never crosses a
#: district line — it has to be a mandal match right at the line.
BORDER_KM = 10.0

_download_lock = asyncio.Lock()
_load_lock = asyncio.Lock()
_places: list["Place"] | None = None
_names: dict[str, list[int]] = {}
_keys: dict[str, list[int]] = {}
_trigrams: dict[str, set[int]] = {}
#: (lat*10, lon*10) cell -> place indexes, for "is there a place of district X near".
_cells: dict[tuple[int, int], list[int]] = {}


@dataclass(frozen=True)
class Place:
    name: str
    normalized: str
    key: str
    latitude: float
    longitude: float
    population: int
    geoname_id: str
    #: Canonical district (see `canonical_district`); "" when the source gave none.
    district: str
    #: The district as the source wrote it, for display.
    district_label: str
    #: GEONAMES (the gazetteer) or POSTAL (a post office).
    source: str = "GEONAMES"
    #: GeoNames postal accuracy: 4 = at the place, 3 = at a nearby place, 1 = only
    #: the postcode's centroid. The gazetteer is always 4.
    accuracy: int = 4
    #: The mandal (sub-district) the source puts it in, as a phonetic key, and as
    #: written. The gazetteer's comes from its ADM3 rows, the postal directory's from
    #: its taluk column. "" when the source gave none.
    mandal: str = ""
    mandal_label: str = ""


@dataclass(frozen=True)
class Match:
    name: str
    latitude: float
    longitude: float
    confidence: float
    geoname_id: str
    district: str = ""
    source: str = "GEONAMES"

    @property
    def label(self) -> str:
        where = f", {self.district.title()}" if self.district else ""
        suffix = " (post office)" if self.source == "POSTAL" else ""
        return f"{self.name}{where}{suffix}"


@dataclass(frozen=True)
class Candidate:
    """One place a stocking point might be, for a person to confirm."""
    name: str
    district: str
    latitude: float
    longitude: float
    score: float
    in_district: bool
    source: str
    accuracy: int
    geoname_id: str
    in_mandal: bool = False
    mandal: str = ""

    def as_dict(self) -> dict:
        return {
            "name": self.name, "district": self.district or None,
            "mandal": self.mandal or None, "in_mandal": self.in_mandal,
            "latitude": round(self.latitude, 6), "longitude": round(self.longitude, 6),
            "score": round(self.score, 3), "in_district": self.in_district,
            "source": self.source, "accuracy": self.accuracy,
            "precise": self.accuracy >= 3,
            "label": Match(self.name, self.latitude, self.longitude, self.score,
                           self.geoname_id, self.district, self.source).label,
        }


# --------------------------------------------------------------------------- #
#  Text: what a name is, once the spelling is taken out of it
# --------------------------------------------------------------------------- #

def normalize(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    return " ".join(re.findall(r"[a-z0-9]+", ascii_value.lower()))


#: Applied in order to a normalised name with its spaces removed.
_FOLDS: list[tuple[re.Pattern, str]] = [(re.compile(a), b) for a, b in (
    (r"^ts", "ch"),                      # Tsuchikonda = Chuchikonda
    (r"t?chch|tch", "ch"),               # Atchutapuram = Achutapuram
    (r"x", "ks"),
    (r"w", "v"),
    (r"(?<=[aeiou])y(?=[aeiou])", ""),   # Ayinavalli = Ainavalli
    (r"(?<=[b-df-hj-np-tv-z])y(?=[b-df-hj-np-tv-z])", "i"),   # Reddypalli = Reddipalli
    (r"ee|ie|ii", "i"),
    (r"oo|uu", "u"),
    (r"aa", "a"),
    (r"ou|ow", "au"),                    # Gouravaram = Gauravaram
    (r"([bcdfgjkpqstvz])h", r"\1"),      # aspirates: th, dh, bh, ch, kh, gh, ph, sh
    (r"([a-z])\1+", r"\1"),              # doubled letters: kotta = kota
    (r"(?<=l)[ey]$", "i"),               # -palle / -pally = -palli
    (r"y$", "i"),                        # Chinthaparthy = Chinthaparthi
    (r"(?<=[bcdfgjklmnpqrstvz])u$", ""),  # Amruthaluru = Amruthalur
)]


def phonetic_key(value: str) -> str:
    """A name with its transliteration variants folded out. Two spellings of one
    Telugu place name meet here; two different names almost never do."""
    key = normalize(value).replace(" ", "")
    for pattern, replacement in _FOLDS:
        key = pattern.sub(replacement, key)
    return key


_GENERIC = {
    "104", "ap", "mmu", "phc", "chc", "tphc", "uphc", "ah", "colocated", "hc",
    "lip", "mdp", "main", "branch", "regional", "office", "warehouse", "ware",
    "house", "dst", "district", "backup", "back", "up", "buffer", "vehicle",
    "co", "located", "dh", "pch", "aam", "bo", "so", "ho",
}


def locality_from_warehouse(name: str) -> str:
    """Extract the place portion from labels such as AP-104-MMU-Nimmanapalli-AP39..."""
    value = re.sub(r"\bAP\d{2}[A-Z]{1,3}\d+\b", " ", name or "", flags=re.I)
    mmu = re.search(r"\bMMU\b", value, flags=re.I)
    if mmu:
        value = value[mmu.end():]
    value = re.sub(r"\b(?:LIP|MDP|MAIN)\b.*$", " ", value, flags=re.I)
    tokens = []
    for token in normalize(value).split():
        # "chcpamur" — a facility prefix glued onto the village.
        token = re.sub(r"^(?:u?phc|chc|hc)(?=[a-z]{4,}$)", "", token)
        if token and token not in _GENERIC:
            tokens.append(token)
    return " ".join(tokens).strip()


def _query_variants(query: str) -> list[tuple[str, float]]:
    """The query, then the query without leading initials ("b kothakota" is the
    Kothakota of mandal B.) — each with the confidence it costs."""
    variants = [(query, 0.0)]
    tokens = query.split()
    stripped = list(tokens)
    while len(stripped) > 1 and len(stripped[0]) <= 2:
        stripped = stripped[1:]
    if stripped != tokens and len(" ".join(stripped)) >= 4:
        variants.append((" ".join(stripped), 0.04))
    return variants


def _grams(value: str) -> set[str]:
    compact = f"  {value.replace(' ', '')}  "
    return {compact[index:index + 3] for index in range(max(1, len(compact) - 2))}


# --------------------------------------------------------------------------- #
#  Districts: HCM's scheme against the gazetteer's two
# --------------------------------------------------------------------------- #

#: Spellings of one district, folded to one word.
_DISTRICT_ALIASES = {
    "anantapur": "anantapur", "ananthapur": "anantapur", "anantapuramu": "anantapur",
    "ananthapuramu": "anantapur",
    "cuddapah": "kadapa", "kadapa": "kadapa", "ysr": "kadapa", "ysr kadapa": "kadapa",
    "y s r": "kadapa", "ysr district": "kadapa", "y s r kadapa": "kadapa",
    "sri potti sriramulu nellore": "nellore", "spsr nellore": "nellore",
    "nellore": "nellore", "potti sriramulu nellore": "nellore",
    "dr b r ambedkar konaseema": "konaseema", "b r ambedkar konaseema": "konaseema",
    "ambedkar konaseema": "konaseema", "konaseema": "konaseema",
    "palanadu": "palnadu", "palnadu": "palnadu",
    "vizianagaram": "vizianagaram", "vizianagaram district": "vizianagaram",
    "visakhapatnam": "visakhapatnam", "vishakhapatnam": "visakhapatnam",
    "vishakapatnam": "visakhapatnam",
    "alluri sitharama raju": "alluri", "alluri sitarama raju": "alluri", "asr": "alluri",
    "parvathipuram manyam": "manyam", "parvatipuram manyam": "manyam", "manyam": "manyam",
    "sri sathya sai": "sathya sai", "sri satya sai": "sathya sai",
    "sathya sai": "sathya sai",
}

#: Which gazetteer districts a place in each HCM district may carry. The new
#: districts were carved out of the old ones, and the gazetteer mixes both schemes,
#: so each new district accepts itself AND its parents. Markapuram and Polavaram are
#: newer than any gazetteer, so they accept only their parents.
DISTRICT_ACCEPTS: dict[str, set[str]] = {
    "alluri": {"alluri", "visakhapatnam", "east godavari"},
    "anakapalli": {"anakapalli", "visakhapatnam"},
    "anantapur": {"anantapur"},
    "annamayya": {"annamayya", "kadapa", "chittoor"},
    "bapatla": {"bapatla", "guntur", "prakasam"},
    "chittoor": {"chittoor"},
    "east godavari": {"east godavari"},
    "eluru": {"eluru", "west godavari", "krishna"},
    "guntur": {"guntur"},
    "kadapa": {"kadapa"},
    "kakinada": {"kakinada", "east godavari"},
    "konaseema": {"konaseema", "east godavari"},
    "krishna": {"krishna"},
    "kurnool": {"kurnool"},
    "manyam": {"manyam", "vizianagaram", "srikakulam"},
    "markapuram": {"markapuram", "prakasam"},
    "nandyal": {"nandyal", "kurnool"},
    "nellore": {"nellore"},
    "ntr": {"ntr", "krishna"},
    "palnadu": {"palnadu", "guntur"},
    "polavaram": {"polavaram", "eluru", "west godavari", "east godavari", "alluri"},
    "prakasam": {"prakasam"},
    "sathya sai": {"sathya sai", "anantapur"},
    "srikakulam": {"srikakulam"},
    "tirupati": {"tirupati", "chittoor", "nellore"},
    "visakhapatnam": {"visakhapatnam"},
    "vizianagaram": {"vizianagaram"},
    "west godavari": {"west godavari"},
}


def canonical_district(value: str) -> str:
    text = normalize(value).replace(" district", "").strip()
    text = re.sub(r"^(?:dr\s+)?b\s*r\s+", "b r ", text)
    return _DISTRICT_ALIASES.get(text, _DISTRICT_ALIASES.get(normalize(value), text))


def mandal_key(value: str | None) -> str:
    """A mandal name as a phonetic key, without the word "mandal"."""
    text = re.sub(r"\b(?:mandal|mandalam|rural|urban|tehsil|taluk)\b", " ",
                  normalize(value or ""))
    # HCM's mandal field carries junk where nobody filled it ("BACKUP").
    if not [token for token in text.split() if token not in _GENERIC]:
        return ""
    return phonetic_key(text) if len(text.strip()) >= 3 else ""


def _close(a: str, b: str) -> bool:
    if not a or not b:
        return False
    return a == b or (min(len(a), len(b)) >= 5
                      and difflib.SequenceMatcher(None, a, b).ratio() >= 0.88)


def in_mandal(place: "Place", wanted: str) -> bool:
    """Is `place` in the mandal HCM names — by the source's own record of its mandal,
    or by BEING that mandal's headquarters (a village named after its mandal)?
    Evidence between places INSIDE the district only: a village named like a mandal
    exists in every district that has a mandal of that name."""
    return bool(wanted) and (_close(place.mandal, wanted) or _close(place.key, wanted))


def _recorded_mandal(place: "Place", wanted: str) -> bool:
    """The source itself records `place` in that mandal — not merely a namesake."""
    return bool(wanted) and _close(place.mandal, wanted)


def _cell(lat: float, lon: float) -> tuple[int, int]:
    return (math.floor(lat * 10), math.floor(lon * 10))


def _on_border(place: "Place", accepted: set[str]) -> bool:
    """Is `place` within `BORDER_KM` of any place that IS in an accepted district?"""
    assert _places is not None
    row, col = _cell(place.latitude, place.longitude)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            for at in _cells.get((row + dr, col + dc), ()):
                other = _places[at]
                if other.district in accepted and _km(other, place) <= BORDER_KM:
                    return True
    return False


def _admissible(place: "Place", accepted: set[str] | None, mandal: str) -> bool:
    """May `place` answer for an office HCM puts in `accepted`? Inside the district,
    yes. Outside it, only as a border case: the source records it in the office's own
    mandal AND it sits right at the district line."""
    if accepted is None or place.district in accepted:
        return True
    return _recorded_mandal(place, mandal) and _on_border(place, accepted)


def accepted_districts(hint: str) -> set[str] | None:
    """The gazetteer districts a place may carry for this HCM district, or None when
    the hint names no district this module knows (and so constrains nothing)."""
    canonical = canonical_district(hint)
    if not canonical:
        return None
    return DISTRICT_ACCEPTS.get(canonical, {canonical})


# --------------------------------------------------------------------------- #
#  Loading
# --------------------------------------------------------------------------- #

def _have(path: Path, min_size: int) -> bool:
    return path.exists() and path.stat().st_size > min_size


async def _download(client: httpx.AsyncClient, url: str, target: Path) -> None:
    temporary = target.with_suffix(target.suffix + ".download")
    async with client.stream("GET", url) as response:
        response.raise_for_status()
        with temporary.open("wb") as output:
            async for chunk in response.aiter_bytes():
                output.write(chunk)
    os.replace(temporary, target)


async def _ensure_data() -> None:
    wanted = ((DATA_URL, DATA_FILE, 1_000_000), (ADMIN2_URL, ADMIN2_FILE, 100_000),
              (POSTAL_URL, POSTAL_FILE, 200_000))
    if all(_have(path, size) for _, path, size in wanted):
        return
    async with _download_lock:
        missing = [(url, path) for url, path, size in wanted if not _have(path, size)]
        if not missing:
            return
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        headers = {"User-Agent": "SCM-ERP-Load-Planner/1.0 (offline gazetteer cache)"}
        async with httpx.AsyncClient(timeout=120, follow_redirects=True,
                                     headers=headers) as client:
            for url, path in missing:
                try:
                    await _download(client, url, path)
                except Exception:
                    # The postal directory is a second source; the gazetteer alone
                    # still works. The gazetteer missing is a real failure.
                    if path == POSTAL_FILE:
                        continue
                    raise


def _load() -> None:
    global _places, _names, _keys, _trigrams, _cells
    if _places is not None:
        return
    places: list[Place] = []
    names: dict[str, list[int]] = defaultdict(list)
    keys: dict[str, list[int]] = defaultdict(list)
    grams: dict[str, set[int]] = defaultdict(set)

    def index(place: Place, aliases: set[str]) -> None:
        at = len(places)
        places.append(place)
        for alias in aliases:
            if not alias:
                continue
            names[alias].append(at)
            key = phonetic_key(alias)
            if key:
                keys[key].append(at)
                for gram in _grams(key):
                    grams[gram].add(at)

    districts = {}
    with ADMIN2_FILE.open(encoding="utf-8") as source:
        for line in source:
            row = line.rstrip("\n").split("\t")
            if len(row) >= 2 and row[0].startswith("IN.02."):
                districts[row[0].split(".")[-1]] = row[1]
    # Two passes' worth in one read: the mandals (ADM3 rows) can come after the
    # villages that sit in them, so the villages are held until every mandal is known.
    mandals: dict[tuple[str, str], str] = {}
    held: list[list[str]] = []
    with zipfile.ZipFile(DATA_FILE) as archive, archive.open("IN.txt") as source:
        for raw in source:
            row = raw.decode("utf-8").rstrip("\n").split("\t")
            if len(row) < 15 or row[8] != "IN" or row[10] != AP_ADMIN1:
                continue
            if row[7] == "ADM3" and row[12]:
                mandals[(row[11], row[12])] = row[1]
            elif row[6] == "P":
                held.append(row)
    for row in held:
        normalized = normalize(row[2] or row[1])
        if not normalized:
            continue
        district = districts.get(row[11], "")
        mandal = mandals.get((row[11], row[12]), "")
        place = Place(
            name=row[1], normalized=normalized, key=phonetic_key(normalized),
            latitude=float(row[4]), longitude=float(row[5]),
            population=int(row[14] or 0), geoname_id=row[0],
            district=canonical_district(district), district_label=district,
            mandal=mandal_key(mandal), mandal_label=mandal,
        )
        aliases = {normalized}
        aliases.update(normalize(alias) for alias in row[3].split(",")[:30] if alias)
        index(place, aliases)

    if _have(POSTAL_FILE, 200_000):
        with zipfile.ZipFile(POSTAL_FILE) as archive, archive.open("IN.txt") as source:
            for raw in source:
                row = raw.decode("utf-8").rstrip("\n").split("\t")
                if len(row) < 12 or not row[3].strip().lower().startswith("andhra"):
                    continue
                # "Duggudurru B.O" — the office type is not part of the village.
                name = re.sub(r"\s+(?:B\.?O|S\.?O|H\.?O|G\.?P\.?O)\.?$", "", row[2].strip(),
                              flags=re.I)
                normalized = normalize(name)
                if not normalized or not row[9] or not row[10]:
                    continue
                try:
                    accuracy = int((row[11] or "1").strip() or 1)
                    lat, lon = float(row[9]), float(row[10])
                except ValueError:
                    continue
                place = Place(
                    name=name, normalized=normalized, key=phonetic_key(normalized),
                    latitude=lat, longitude=lon, population=0,
                    geoname_id=f"PIN{row[1]}", district=canonical_district(row[5]),
                    district_label=row[5], source="POSTAL", accuracy=accuracy,
                    mandal=mandal_key(row[7]), mandal_label=row[7].strip(),
                )
                index(place, {normalized})
    cells: dict[tuple[int, int], list[int]] = defaultdict(list)
    for at, place in enumerate(places):
        if place.district:
            cells[_cell(place.latitude, place.longitude)].append(at)
    _places, _names, _keys, _trigrams, _cells = (places, dict(names), dict(keys),
                                                 dict(grams), dict(cells))


async def ready() -> None:
    await _ensure_data()
    if _places is None:
        async with _load_lock:
            if _places is None:
                await asyncio.to_thread(_load)


# --------------------------------------------------------------------------- #
#  Matching
# --------------------------------------------------------------------------- #

def _km(a: Place, b: Place) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a.latitude, a.longitude,
                                                b.latitude, b.longitude))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 6371.0 * 2 * math.asin(min(1.0, math.sqrt(h)))


def _rank(place: Place) -> tuple:
    """Which of several equally-named candidates stands for the place: the gazetteer
    over a post office, precise over a postcode centroid, then the bigger town."""
    return (place.source == "GEONAMES", place.accuracy, place.population)


def _scored(query: str) -> list[tuple[float, int]]:
    """(score, place index) for every plausible spelling of `query`, best first."""
    assert _places is not None
    key = phonetic_key(query)
    if len(key) < 3:
        return []
    out: dict[int, float] = {}
    for at in _names.get(query, []):
        out[at] = 0.99
    for at in _keys.get(key, []):
        out.setdefault(at, 0.97)
    # Trigram hits, counted, and only the best-supported few compared in full:
    # SequenceMatcher is the expensive half, and common grams ("pal", "pur") would
    # otherwise hand it thousands of places per query.
    query_grams = _grams(key)
    hits: Counter = Counter()
    for gram in query_grams:
        hits.update(_trigrams.get(gram, ()))
    floor = max(2, int(len(query_grams) * 0.45))
    shortlist = [at for at, count in hits.most_common(_FUZZY_SHORTLIST * 4)
                 if count >= floor and at not in out][:_FUZZY_SHORTLIST]
    for at in shortlist:
        place = _places[at]
        ratio = difflib.SequenceMatcher(None, key, place.key).ratio()
        if ratio >= 0.75:
            out[at] = min(0.95, ratio)
    return sorted(((score, at) for at, score in out.items()), reverse=True)


def _clusters(places: list[Place]) -> list[list[Place]]:
    """Group same-named candidates into places: members within `CLUSTER_KM` of the
    cluster's first member are one place listed more than once."""
    groups: list[list[Place]] = []
    for place in sorted(places, key=_rank, reverse=True):
        home = next((group for group in groups if _km(group[0], place) <= CLUSTER_KM), None)
        if home is None:
            groups.append([place])
        else:
            home.append(place)
    return groups


def _evidence(group: list[Place], mandal: str = "",
              district: str = "") -> tuple[int, int, int, int]:
    """How well-attested a cluster is, most telling first:

    1. a source RECORDS it in the office's own mandal — of two Ananthagiris in one
       district, the one in Ananthagiri mandal is the one HCM means (a namesake of
       the mandal is not evidence: every Ananthagiri is named like the mandal);
    2. it is in HCM's exact district, not merely the old parent district it was cut
       from — Konaseema, not "East Godavari";
    3. a populated place is in it;
    4. both sources agree it is there — a post office AND a gazetteer entry within a
       few kilometres is the village; a lone hamlet thirty kilometres off is not.
    """
    return (int(any(_recorded_mandal(place, mandal) for place in group)),
            int(bool(district) and any(place.district == district for place in group)),
            int(any(place.population >= 1000 for place in group)),
            len({place.source for place in group}))


def _decide(scored: list[tuple[float, int]], accepted: set[str] | None,
            penalty: float, mandal: str = "", district: str = "") -> Match | None:
    """The one place `scored` names, or None when it is not one place."""
    assert _places is not None
    # Looked up without its leading initials ("N Kothapalli" -> "Kothapalli"): the
    # shorter name is far commoner, so it is held to the mandal like a near-spelling.
    stripped = penalty > 0
    # A postcode centroid is not a village: offered to a person, never applied.
    precise = [(score, _places[at]) for score, at in scored if _places[at].accuracy >= 3]
    pool = precise
    if accepted is not None:
        # Outside HCM's district counts only when the place's OWN mandal is HCM's:
        # the district is where two schemes of boundaries disagree, the mandal is a
        # finer and independent fact, and a border mandal is exactly the case.
        pool = [(score, place) for score, place in precise
                if _admissible(place, accepted, mandal)]
    if not pool:
        return None
    best_score, top = pool[0]
    if best_score < 0.97:                     # fuzzy only: must be tight and unique
        vouched = (in_mandal(top, mandal) if accepted is None or top.district in accepted
                   else _recorded_mandal(top, mandal))
        if best_score < (FUZZY_MIN_WITH_MANDAL if vouched else FUZZY_MIN):
            return None
        # The name itself exists — spelled exactly — somewhere else in the state, and
        # only a near-spelling exists here. That is the district being wrong or the
        # spelling being different, and neither is for a machine to pick — unless the
        # near-spelling sits in the office's own mandal.
        if accepted is not None and not vouched and any(score >= 0.97 for score, _ in precise):
            return None
        # Unvouched, the best spelling must clearly beat any other place. Vouched by
        # the mandal, a rival of the same spelling is settled by the evidence below
        # instead — and refused there too unless one side clearly wins.
        if not vouched:
            rival = next((score for score, place in pool[1:]
                          if _km(place, top) > CLUSTER_KM), None)
            if rival is not None and best_score - rival < FUZZY_MARGIN:
                return None
        else:
            pool = [(score, place) for score, place in pool
                    if best_score - score > 0.015 or in_mandal(place, mandal)
                    or _recorded_mandal(place, mandal)]
    tied = [place for score, place in pool if best_score - score <= 0.015]
    groups = _clusters(tied)
    if len(groups) > 1:
        # Two different places of one name. Chosen only when one is clearly the
        # better attested; otherwise a person picks (`candidates`).
        ranked = sorted(groups, key=lambda group: _evidence(group, mandal, district),
                        reverse=True)
        if _evidence(ranked[0], mandal, district) <= _evidence(ranked[1], mandal, district):
            return None
        # Settled on the mandal record costs nothing: that is a source saying which
        # one. Settled on anything weaker costs a little confidence.
        if not (_evidence(ranked[0], mandal, district)[0]
                and not _evidence(ranked[1], mandal, district)[0]):
            penalty += 0.02
        groups = ranked[:1]
    group = groups[0]
    chosen = max(group, key=lambda place: (in_mandal(place, mandal), *_rank(place)))
    # A near-spelling the gazetteer itself puts in a DIFFERENT mandal from HCM's is a
    # different village — Angara is not Dangara. Only the gazetteer's mandal is used
    # against a match: the postal directory's "taluk" is as often the revenue division
    # or the district town as the mandal, so it counts only when it agrees.
    if ((best_score < 0.97 or stripped) and mandal and chosen.source == "GEONAMES"
            and chosen.mandal and not in_mandal(chosen, mandal)):
        return None
    if accepted is not None and chosen.district not in accepted:
        penalty += 0.02                       # admitted on the mandal alone
    spread = 0.01 if len(tied) > 1 else 0.0
    corroborated = len({place.source for place in group}) > 1
    source_cost = 0.0 if chosen.source == "GEONAMES" or corroborated else 0.02
    confidence = round(best_score - penalty - spread - source_cost, 4)
    return Match(chosen.name, chosen.latitude, chosen.longitude, confidence,
                 chosen.geoname_id, chosen.district_label or chosen.district,
                 chosen.source)


def _queries(warehouse_name: str, locality: str | None) -> list[tuple[str, float]]:
    """What to look up, best first: HCM's own `location` for the office (a clean
    village name), then the place parsed out of the warehouse label, each with its
    initials-stripped variant."""
    out: dict[str, float] = {}
    for text in (locality, warehouse_name):
        query = locality_from_warehouse(text or "")
        if len(query) < 3:
            continue
        for variant, penalty in _query_variants(query):
            out.setdefault(variant, penalty)
    return list(out.items())


def _resolve_sync(warehouse_name: str, district_hint: str = "", locality: str | None = None,
                  mandal: str | None = None) -> Match | None:
    accepted = accepted_districts(district_hint)
    wanted = mandal_key(mandal)
    exact = canonical_district(district_hint)
    for variant, penalty in _queries(warehouse_name, locality):
        match = _decide(_scored(variant), accepted, penalty, wanted, exact)
        if match is not None and match.confidence >= MIN_CONFIDENCE:
            return match
    return None


def _plausible_sync(warehouse_name: str, district_hint: str, latitude: float,
                    longitude: float, locality: str | None = None,
                    mandal: str | None = None) -> bool:
    """Could an EARLIER automatic match at (lat, lon) be right, by today's rules?

    True when a place of that name in the office's own district lies within
    `CLUSTER_KM` of it — the earlier matcher found the right village and today's
    only declines to choose between it and a namesake. False when every such place
    is far away: the earlier matcher reached outside the district, which is how a
    PHC in Srikakulam came to be drawn 300 km south of it.
    """
    accepted = accepted_districts(district_hint)
    if accepted is None:
        return True
    here = Place("", "", "", float(latitude), float(longitude), 0, "", "", "")
    for row in _candidates_sync(warehouse_name, district_hint, limit=40,
                                locality=locality, mandal=mandal):
        if row.in_district and _km(Place("", "", "", row.latitude, row.longitude, 0, "",
                                         "", ""), here) <= CLUSTER_KM:
            return True
    return False


def _candidates_sync(query: str, district_hint: str = "", limit: int = 8, *,
                     locality: str | None = None,
                     mandal: str | None = None) -> list[Candidate]:
    """Places a stocking point might be, for a person to choose between.

    Wider than `resolve` on purpose — every spelling that is plausibly the same name,
    postcode centroids included — and ranked with the office's own district first,
    because the person choosing knows which district the PHC is in.
    """
    assert _places is not None
    queries = _queries(query, locality)
    if not queries and len(normalize(query)) >= 3:
        queries = _query_variants(normalize(query))
    if not queries:
        return []
    accepted = accepted_districts(district_hint)
    wanted = mandal_key(mandal)
    seen: dict[str, tuple[float, Place]] = {}
    for variant, penalty in queries:
        for score, at in _scored(variant)[:200]:
            place = _places[at]
            ident = f"{place.key}|{round(place.latitude, 2)}|{round(place.longitude, 2)}"
            value = score - penalty
            if ident not in seen or seen[ident][0] < value:
                seen[ident] = (value, place)
    rows = []
    for value, place in seen.values():
        in_district = accepted is not None and place.district in accepted
        rows.append(Candidate(place.name, place.district_label or place.district,
                              place.latitude, place.longitude, value, in_district,
                              place.source, place.accuracy, place.geoname_id,
                              in_mandal=in_mandal(place, wanted),
                              mandal=place.mandal_label))
    rows.sort(key=lambda row: (not (row.in_district or row.in_mandal), not row.in_mandal,
                               -round(row.score, 2), row.source != "GEONAMES",
                               -row.accuracy))
    return rows[:limit]


# --------------------------------------------------------------------------- #
#  The async surface. Matching is pure CPU; it runs in a worker thread so a map
#  of a thousand points never stalls every other request on the event loop.
# --------------------------------------------------------------------------- #

async def resolve(warehouse_name: str, district_hint: str = "", locality: str | None = None,
                  mandal: str | None = None) -> Match | None:
    """The one place this stocking point is, or None if that is not certain."""
    await ready()
    return await asyncio.to_thread(_resolve_sync, warehouse_name, district_hint,
                                   locality, mandal)


async def resolve_many(items: list[tuple]) -> list[Match | None]:
    """`resolve` for many (name, district[, locality, mandal]) in one thread hop."""
    await ready()
    return await asyncio.to_thread(lambda: [_resolve_sync(*item) for item in items])


async def plausible(warehouse_name: str, district_hint: str, latitude: float,
                    longitude: float, locality: str | None = None,
                    mandal: str | None = None) -> bool:
    await ready()
    return await asyncio.to_thread(_plausible_sync, warehouse_name, district_hint,
                                   latitude, longitude, locality, mandal)


async def plausible_many(items: list[tuple]) -> list[bool]:
    await ready()
    return await asyncio.to_thread(lambda: [_plausible_sync(*item) for item in items])


async def candidates(query: str, district_hint: str = "", limit: int = 8, *,
                     locality: str | None = None,
                     mandal: str | None = None) -> list[Candidate]:
    """Places a stocking point might be, for a person to choose between."""
    await ready()
    return await asyncio.to_thread(lambda: _candidates_sync(
        query, district_hint, limit, locality=locality, mandal=mandal))
