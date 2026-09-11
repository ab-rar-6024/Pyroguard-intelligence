// Tracks recurring thermal detections at the same location across refresh
// cycles to distinguish persistent thermal sources (gas flares, coal-seam
// fires, kilns) from one-off fire events, per SIH PS 26162.
//
// NOTE: this is an in-memory grid. On serverless platforms (e.g. Vercel) it
// only persists for the lifetime of a warm function instance and resets on
// cold start, same caveat as the rest of this app's in-memory state.

interface TrackedCell {
  firstSeenAt: number;
  lastSeenAt: number;
  occurrences: number;
  avgFrp: number;
}

const grid = new Map<string, TrackedCell>();

// ~5.5km grid cells at the equator - coarse enough that repeat satellite
// passes over the same industrial source or flare stack land in the same
// cell, fine enough not to conflate distinct nearby hotspots.
const GRID_SIZE_DEG = 0.05;
const PERSISTENCE_MIN_OCCURRENCES = 3;
const CELL_EXPIRY_MS = 24 * 60 * 60 * 1000;

function gridKey(lat: number, lon: number): string {
  const gLat = Math.round(lat / GRID_SIZE_DEG) * GRID_SIZE_DEG;
  const gLon = Math.round(lon / GRID_SIZE_DEG) * GRID_SIZE_DEG;
  return `${gLat.toFixed(3)},${gLon.toFixed(3)}`;
}

export interface PersistenceResult {
  isPersistent: boolean;
  occurrences: number;
  firstSeenAt: string;
}

export function recordDetection(lat: number, lon: number, frp: number): PersistenceResult {
  const key = gridKey(lat, lon);
  const now = Date.now();
  const existing = grid.get(key);

  if (existing) {
    existing.lastSeenAt = now;
    existing.occurrences += 1;
    existing.avgFrp = (existing.avgFrp * (existing.occurrences - 1) + frp) / existing.occurrences;
    return {
      isPersistent: existing.occurrences >= PERSISTENCE_MIN_OCCURRENCES,
      occurrences: existing.occurrences,
      firstSeenAt: new Date(existing.firstSeenAt).toISOString()
    };
  }

  grid.set(key, { firstSeenAt: now, lastSeenAt: now, occurrences: 1, avgFrp: frp });
  return { isPersistent: false, occurrences: 1, firstSeenAt: new Date(now).toISOString() };
}

// Bound memory growth by evicting cells that haven't recurred recently.
export function pruneStaleCells(): void {
  const now = Date.now();
  for (const [key, cell] of grid.entries()) {
    if (now - cell.lastSeenAt > CELL_EXPIRY_MS) {
      grid.delete(key);
    }
  }
}

export function getTrackedCellCount(): number {
  return grid.size;
}
