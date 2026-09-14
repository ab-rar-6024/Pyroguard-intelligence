import { LandCoverType } from '../types.js';

// Resolves land-use context (forest/farmland/industrial/urban) around a
// coordinate, used as a classification signal for hotspots that aren't near
// a known industrial facility - per SIH PS 26162's requirement to integrate
// "NASA FIRMS, OSM & Satellite Data".
//
// Tried in priority order: Geoapify Places API (GEOAPIFY_API_KEY, no card
// required on its free tier) -> Mapbox Tilequery (MAPBOX_ACCESS_TOKEN) ->
// public OSM Overpass mirrors as a last resort. The Overpass mirrors are
// unreliable from this app's Vercel deployment: measured in production, all
// three were unreachable (connections hang at TCP/TLS connect and never
// complete - 0 successful lookups across a full session of live traffic),
// which matches known behavior of free Overpass instances blocking or
// dropping connections from cloud/datacenter IP ranges. Geoapify and Mapbox
// are commercial services designed for exactly this kind of programmatic,
// server-side traffic and have no such block.
//
// Bounded and cached deliberately regardless of source: this app may have
// hundreds of far-field hotspots per refresh. Only a capped, prioritized
// subset is ever queried (see batchQueryLandCover call sites) and results
// are cached per ~11km grid cell so recurring hotspots in the same area
// don't re-trigger a network call every cycle.

interface CacheEntry {
  type: LandCoverType;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_GRID_SIZE_DEG = 0.1;
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 60 * 1000;
// Measured: the primary Overpass mirror can legitimately take ~1.2-2.7s to
// respond even on success, so a too-tight timeout was cutting off real
// answers right before they arrived. Mirrors are raced in parallel (see
// queryLandCover) rather than tried sequentially, so this is the total
// worst-case wait per lookup, not a per-mirror budget stacked three times.
const OVERPASS_TIMEOUT_MS = 6000;

// AbortSignal.timeout() alone has been observed to not reliably bound the
// wall-clock time of a fetch() call on every platform/runtime. Race it
// against a plain timer so a slow or hanging connection to the public
// Overpass endpoint can never stall a refresh cycle beyond this budget.
function fetchWithHardTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return Promise.race([
    fetch(url, init),
    new Promise<Response>((_, reject) => {
      setTimeout(() => reject(new Error('land-cover fetch hard timeout')), timeoutMs);
    })
  ]);
}

function cacheKey(lat: number, lon: number): string {
  const gLat = Math.round(lat / CACHE_GRID_SIZE_DEG) * CACHE_GRID_SIZE_DEG;
  const gLon = Math.round(lon / CACHE_GRID_SIZE_DEG) * CACHE_GRID_SIZE_DEG;
  return `${gLat.toFixed(2)},${gLon.toFixed(2)}`;
}

function classifyFromOsmTags(elements: Array<{ tags?: Record<string, string> }>): LandCoverType {
  const tagCounts: Record<LandCoverType, number> = { forest: 0, farmland: 0, industrial: 0, urban: 0, unknown: 0 };

  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.natural === 'wood' || tags.landuse === 'forest') {
      tagCounts.forest++;
    } else if (['farmland', 'farmyard', 'orchard', 'allotments', 'meadow'].includes(tags.landuse || '')) {
      tagCounts.farmland++;
    } else if (['industrial', 'quarry'].includes(tags.landuse || '')) {
      tagCounts.industrial++;
    } else if (['residential', 'commercial', 'retail'].includes(tags.landuse || '')) {
      tagCounts.urban++;
    }
  }

  const sorted = (Object.entries(tagCounts) as [LandCoverType, number][]).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : 'unknown';
}

// Mapbox Streets v8's "landuse" layer carries both landuse (agriculture,
// industrial, residential...) and landcover (wood, scrub, grass, rock,
// sand...) features under one layer - see
// https://docs.mapbox.com/data/tilesets/reference/mapbox-streets-v8/
const MAPBOX_CLASS_TO_LAND_COVER: Record<string, LandCoverType> = {
  wood: 'forest',
  scrub: 'forest',
  agriculture: 'farmland',
  grass: 'farmland',
  industrial: 'industrial',
  facility: 'industrial',
  airport: 'industrial',
  residential: 'urban',
  commercial_area: 'urban',
  school: 'urban',
  hospital: 'urban',
  cemetery: 'urban',
  park: 'urban',
  parking: 'urban',
  pitch: 'urban',
  piste: 'urban'
};

function classifyFromMapboxFeatures(features: Array<{ properties?: Record<string, any> }>): LandCoverType {
  const tagCounts: Record<LandCoverType, number> = { forest: 0, farmland: 0, industrial: 0, urban: 0, unknown: 0 };

  for (const f of features) {
    const cls = f.properties?.class as string | undefined;
    const mapped = cls ? MAPBOX_CLASS_TO_LAND_COVER[cls] : undefined;
    if (mapped) tagCounts[mapped]++;
  }

  const sorted = (Object.entries(tagCounts) as [LandCoverType, number][]).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : 'unknown';
}

const MAPBOX_TIMEOUT_MS = 6000;
const MAPBOX_QUERY_RADIUS_M = 1500;

async function queryLandCoverMapbox(lat: number, lon: number, token: string): Promise<LandCoverType> {
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lon},${lat}.json` +
    `?radius=${MAPBOX_QUERY_RADIUS_M}&layers=landuse&limit=10&access_token=${token}`;

  const res = await fetchWithHardTimeout(url, {
    signal: AbortSignal.timeout(MAPBOX_TIMEOUT_MS)
  }, MAPBOX_TIMEOUT_MS);

  if (!res.ok) throw new Error(`Mapbox Tilequery status ${res.status}`);
  const data = await res.json();
  return classifyFromMapboxFeatures(data.features || []);
}

// Geoapify's Places API is POI-based (named places, not raw OSM landuse
// polygons), so this is a weaker signal than Mapbox/Overpass for plain
// unnamed farmland - but it reliably catches forest, industrial and
// residential/urban areas, and its free tier needs no credit card.
const GEOAPIFY_CATEGORY_TO_LAND_COVER: Record<string, LandCoverType> = {
  'natural.forest': 'forest',
  'natural.heath_moor': 'forest',
  'natural.protected_area': 'forest',
  'natural.wetland': 'forest',
  'commercial.food_and_drink.farm': 'farmland',
  'building.industrial': 'industrial',
  'production.factory': 'industrial',
  'production.brewery': 'industrial',
  'production.distillery': 'industrial',
  'production.winery': 'industrial',
  'building.residential': 'urban',
  'building.commercial': 'urban',
  'building.dormitory': 'urban',
  'building.office': 'urban'
};

const GEOAPIFY_CATEGORIES = Object.keys(GEOAPIFY_CATEGORY_TO_LAND_COVER).join(',');
const GEOAPIFY_TIMEOUT_MS = 6000;
const GEOAPIFY_QUERY_RADIUS_M = 1500;

function classifyFromGeoapifyFeatures(features: Array<{ properties?: Record<string, any> }>): LandCoverType {
  const tagCounts: Record<LandCoverType, number> = { forest: 0, farmland: 0, industrial: 0, urban: 0, unknown: 0 };

  for (const f of features) {
    const categories: string[] = f.properties?.categories || [];
    for (const cat of categories) {
      const mapped = GEOAPIFY_CATEGORY_TO_LAND_COVER[cat];
      if (mapped) tagCounts[mapped]++;
    }
  }

  const sorted = (Object.entries(tagCounts) as [LandCoverType, number][]).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : 'unknown';
}

async function queryLandCoverGeoapify(lat: number, lon: number, apiKey: string): Promise<LandCoverType> {
  const url = `https://api.geoapify.com/v2/places?categories=${GEOAPIFY_CATEGORIES}` +
    `&filter=circle:${lon},${lat},${GEOAPIFY_QUERY_RADIUS_M}&limit=10&apiKey=${apiKey}`;

  const res = await fetchWithHardTimeout(url, {
    signal: AbortSignal.timeout(GEOAPIFY_TIMEOUT_MS)
  }, GEOAPIFY_TIMEOUT_MS);

  if (!res.ok) throw new Error(`Geoapify Places status ${res.status}`);
  const data = await res.json();
  return classifyFromGeoapifyFeatures(data.features || []);
}

// Multiple public Overpass mirrors, raced in parallel. Kept only as a
// fallback for deployments without MAPBOX_ACCESS_TOKEN configured - see the
// file-level comment for why these are unreliable from serverless/cloud
// deployments in practice.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

async function queryLandCoverOverpass(lat: number, lon: number): Promise<LandCoverType> {
  const query = `[out:json][timeout:5];(way(around:1500,${lat},${lon})["landuse"];way(around:1500,${lat},${lon})["natural"="wood"];);out tags 5;`;

  // Race all mirrors in parallel and take whichever answers first, instead
  // of trying them one at a time - sequential trials meant a single lookup
  // could stack up to 3 timeouts back to back (3x the actual budget) before
  // giving up, which was starving the per-refresh query budget.
  const attempts = OVERPASS_ENDPOINTS.map(async (endpoint) => {
    const res = await fetchWithHardTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass instances reject or deprioritize requests with no
        // identifying User-Agent (some return 406/429 outright) - this is
        // the standard fix per the Overpass API usage policy.
        'User-Agent': 'PyroGuard-Fire-Intelligence/1.0 (industrial thermal monitoring app)',
        'Accept': 'application/json'
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS)
    }, OVERPASS_TIMEOUT_MS);

    if (!res.ok) throw new Error(`${endpoint} status ${res.status}`);
    const data = await res.json();
    return data.elements || [];
  });

  const elements = await Promise.any(attempts);
  return classifyFromOsmTags(elements);
}

// Synchronous, no-network cache check - used to resolve land cover for
// hotspots that share a grid cell with one already queried this session,
// without spending any of the per-refresh network query budget on them.
export function peekLandCoverCache(lat: number, lon: number): LandCoverType | undefined {
  const cached = cache.get(cacheKey(lat, lon));
  return cached && cached.expiresAt > Date.now() ? cached.type : undefined;
}

export async function queryLandCover(lat: number, lon: number): Promise<LandCoverType> {
  const key = cacheKey(lat, lon);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.type;
  }

  const geoapifyKey = process.env.GEOAPIFY_API_KEY;
  const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN;

  try {
    const type = geoapifyKey
      ? await queryLandCoverGeoapify(lat, lon, geoapifyKey)
      : mapboxToken
        ? await queryLandCoverMapbox(lat, lon, mapboxToken)
        : await queryLandCoverOverpass(lat, lon);
    cache.set(key, { type, expiresAt: Date.now() + SUCCESS_TTL_MS });
    return type;
  } catch (err: any) {
    // Source unreachable/erroring - this is a routine fallback path for a
    // third-party geodata dependency, not an application error. Cache the
    // miss briefly so a flaky window doesn't get re-hammered every time this
    // same area recurs in a refresh cycle.
    if (err instanceof AggregateError) {
      console.warn(`[Land Cover] all Overpass mirrors failed for ${key}: ${err.errors.map((e: any) => e.message).join('; ')}`);
    } else {
      console.warn(`[Land Cover] lookup failed for ${key}: ${err.message}`);
    }
    cache.set(key, { type: 'unknown', expiresAt: Date.now() + FAILURE_TTL_MS });
    return 'unknown';
  }
}

// Concurrency-limited batch lookup so we never fire off hundreds of parallel
// requests at the public Overpass endpoint in one refresh cycle.
export async function batchQueryLandCover(
  points: { lat: number; lon: number }[],
  maxConcurrent = 8
): Promise<LandCoverType[]> {
  const results: LandCoverType[] = new Array(points.length).fill('unknown');
  let cursor = 0;

  async function worker() {
    while (cursor < points.length) {
      const current = cursor++;
      results[current] = await queryLandCover(points[current].lat, points[current].lon);
    }
  }

  const workerCount = Math.min(maxConcurrent, points.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
