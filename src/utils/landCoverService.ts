import { LandCoverType } from '../types.js';

// Queries OpenStreetMap (via the public Overpass API) for land-use context
// around a coordinate, used as a classification signal for hotspots that
// aren't near a known industrial facility - per SIH PS 26162's requirement
// to integrate "NASA FIRMS, OSM & Satellite Data".
//
// Bounded and cached deliberately: Overpass is a shared public service with
// no SLA, and this app may have hundreds of far-field hotspots per refresh.
// Only a capped, prioritized subset is ever queried (see batchQueryLandCover
// call sites) and results are cached per ~11km grid cell so recurring
// hotspots in the same area don't re-trigger a network call every cycle.

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

// Multiple public Overpass mirrors, tried in order. The reference instance
// (overpass-api.de) is frequently rate-limited/slow; falling through to
// alternate mirrors materially improves real-world success rate for a free,
// unauthenticated dependency with no SLA.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

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

  const query = `[out:json][timeout:5];(way(around:1500,${lat},${lon})["landuse"];way(around:1500,${lat},${lon})["natural"="wood"];);out tags 5;`;

  // Race all mirrors in parallel and take whichever answers first, instead
  // of trying them one at a time - sequential trials meant a single lookup
  // could stack up to 3 timeouts back to back (3x the actual budget) before
  // giving up, which was starving the per-refresh query budget. Measured
  // in production: the reference instance (overpass-api.de) usually wins,
  // but which mirror is fastest varies, so racing all three is both faster
  // and more resilient than betting on one order.
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

  try {
    const elements = await Promise.any(attempts);
    const type = classifyFromOsmTags(elements);
    cache.set(key, { type, expiresAt: Date.now() + SUCCESS_TTL_MS });
    return type;
  } catch (err: any) {
    // All mirrors failed/timed out - this is an expected, routine fallback
    // path for a free, unauthenticated public service with no SLA, not an
    // application error. Cache the miss briefly so a flaky window doesn't
    // get re-hammered every time this same area recurs in a refresh cycle.
    if (err instanceof AggregateError) {
      console.warn(`[OSM Land Cover] all mirrors failed for ${key}: ${err.errors.map((e: any) => e.message).join('; ')}`);
    }
    cache.set(key, { type: 'unknown', expiresAt: Date.now() + FAILURE_TTL_MS });
    return 'unknown';
  }
}

// Diagnostic-only: same request as queryLandCover but returns every
// mirror's raw outcome instead of swallowing errors into 'unknown', and
// never touches the cache. Used to answer "can this deployment's network
// reach Overpass at all" from a live route instead of guessing from
// aggregate classification stats.
export async function queryLandCoverDebug(lat: number, lon: number): Promise<{ endpoint: string; ok: boolean; detail: string }[]> {
  const query = `[out:json][timeout:5];(way(around:1500,${lat},${lon})["landuse"];way(around:1500,${lat},${lon})["natural"="wood"];);out tags 5;`;
  const results: { endpoint: string; ok: boolean; detail: string }[] = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const startedAt = Date.now();
    try {
      const res = await fetchWithHardTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'PyroGuard-Fire-Intelligence/1.0 (industrial thermal monitoring app)',
          'Accept': 'application/json'
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS)
      }, OVERPASS_TIMEOUT_MS);

      const tookMs = Date.now() - startedAt;
      if (!res.ok) {
        results.push({ endpoint, ok: false, detail: `HTTP ${res.status} after ${tookMs}ms` });
        continue;
      }
      const data = await res.json();
      results.push({ endpoint, ok: true, detail: `${(data.elements || []).length} elements in ${tookMs}ms` });
    } catch (err: any) {
      results.push({ endpoint, ok: false, detail: `${err.message} after ${Date.now() - startedAt}ms` });
    }
  }

  return results;
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
