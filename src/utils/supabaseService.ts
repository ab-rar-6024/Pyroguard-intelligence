import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ThermalAnomaly, EmergencyAlert, FireClassification, LandCoverType, FireReport } from '../types.js';
import { gridKey } from './persistenceTracker.js';
import { GLOBAL_INDUSTRIAL_FACILITIES } from '../data/industrialDatabase.js';

// Persists PyroGuard's live data to Supabase (Postgres), when configured.
// Replaces the earlier Firestore-based design: Firestore's Spark (free)
// plan hard-quotas at 20K writes/day, and this app's own routine
// operation - upserting ~180-300 hotspot docs every 5-minute refresh -
// structurally exceeds that on its own (~52K/day) under continuous use,
// independent of any manual testing. Supabase's free tier has no
// per-write-operation daily quota; its constraints are storage (500MB)
// and compute/connections, and a single upsert call here writes every row
// in one request rather than being billed/counted per row.
//
// Storage design carried over unchanged: thermal hotspots are a CURRENT
// SNAPSHOT, one row per real-world location (keyed by the same ~5.5km
// grid cell used for in-process persistence tracking), upserted in place
// rather than appended forever - a snapshot answers "what's burning right
// now" and stays small. Stale hotspots (not re-detected in STALE_AFTER_MS)
// are swept on each refresh. Alerts and citizen fire reports are
// naturally low-volume and stored append-only, one row per event.
//
// See supabase/schema.sql for the table definitions this expects.

const HOTSPOTS_TABLE = 'thermal_hotspots';
const ALERTS_TABLE = 'alerts';
const REPORTS_TABLE = 'fire_reports';
const STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours with no re-detection

// Defensive timeout, same Promise.race pattern used throughout this
// project for any network call - Supabase/Postgres has no known
// equivalent of Firestore's invisible SDK-level retry-with-backoff on
// quota errors, but any network call can still hang for unrelated
// reasons (DNS, a dropped connection), and a serverless route should
// never depend on one indefinitely.
function withHardTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => {
        console.warn(`[Supabase] ${label} exceeded ${timeoutMs}ms - proceeding without it.`);
        resolve(fallback);
      }, timeoutMs);
    })
  ]);
}

let client: SupabaseClient | null = null;
let initAttempted = false;

function getClient(): SupabaseClient | null {
  if (initAttempted) return client;
  initAttempted = true;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    console.warn('[Supabase] Not configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing) - fire data will not be persisted.');
    return null;
  }

  try {
    // service_role bypasses Row Level Security entirely, server-side only
    // - equivalent to how the Firebase Admin SDK bypassed Firestore rules.
    client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    console.log('[Supabase] Connected - persisting fire data to', url);
    return client;
  } catch (err: any) {
    console.error('[Supabase] Failed to initialize:', err.message);
    return null;
  }
}

export function isDatabaseConfigured(): boolean {
  return getClient() !== null;
}

function anomalyToRow(anomaly: ThermalAnomaly) {
  return {
    grid_key: gridKey(anomaly.latitude, anomaly.longitude),
    latitude: anomaly.latitude,
    longitude: anomaly.longitude,
    frp_mw: anomaly.frp,
    brightness_kelvin: anomaly.brightness,
    satellite: anomaly.satellite,
    confidence: anomaly.confidence,
    acq_date: anomaly.acq_date,
    acq_time: anomaly.acq_time,
    daynight: anomaly.daynight,
    wind_speed_kmh: anomaly.windSpeedKmh,
    wind_direction_deg: anomaly.windDirectionDeg,
    nearest_facility: anomaly.nearestFacility
      ? {
          facilityId: anomaly.nearestFacility.facility.id,
          facilityName: anomaly.nearestFacility.facility.name,
          facilityType: anomaly.nearestFacility.facility.type,
          country: anomaly.nearestFacility.facility.country,
          distanceKm: anomaly.nearestFacility.distanceKm,
          threatScore: anomaly.nearestFacility.threatScore,
          threatLevel: anomaly.nearestFacility.threatLevel,
          timeToImpactHours: anomaly.nearestFacility.timeToImpactHours,
          windSpreadRisk: anomaly.nearestFacility.windSpreadRisk
        }
      : null,
    fire_type: anomaly.classification?.classification || 'UNKNOWN',
    classification_confidence: anomaly.classification?.confidence ?? null,
    classification_reasoning: anomaly.classification?.reasoning ?? null,
    is_persistent_source: anomaly.classification?.isPersistent ?? false,
    occurrences: anomaly.classification?.occurrences ?? 1,
    land_cover: anomaly.classification?.landCover ?? 'unknown',
    updated_at: new Date().toISOString()
  };
}

export interface SaveSnapshotResult {
  ok: boolean;
  writes: number;
  reason?: string;
}

// Upserts the current batch of classified hotspots as a snapshot in ONE
// request (unlike Firestore's batch commit, which counted - and billed -
// each document individually), then sweeps rows not re-detected recently.
export async function saveThermalSnapshot(anomalies: ThermalAnomaly[]): Promise<SaveSnapshotResult> {
  const db = getClient();
  if (!db) return { ok: false, writes: 0, reason: 'not configured' };

  return withHardTimeout((async (): Promise<SaveSnapshotResult> => {
    try {
      // Postgres' ON CONFLICT DO UPDATE errors ("cannot affect row a second
      // time") if the same conflict key appears twice in one upsert batch -
      // unlike Firestore's per-document .set() calls, which silently let a
      // later write in the same batch win. Two curated hotspots can land in
      // the same ~5.5km grid cell, so de-dupe by grid_key first (last one
      // wins) before upserting.
      const rowsByKey = new Map(anomalies.map(a => anomalyToRow(a)).map(row => [row.grid_key, row]));
      const rows = [...rowsByKey.values()];
      const seenKeys = rows.map(r => r.grid_key);

      if (rows.length > 0) {
        const { error } = await db.from(HOTSPOTS_TABLE).upsert(rows, { onConflict: 'grid_key' });
        if (error) throw error;
      }

      await sweepStaleHotspots(db, seenKeys);
      return { ok: true, writes: rows.length };
    } catch (err: any) {
      console.error('[Supabase] Failed to save thermal snapshot:', err.message);
      return { ok: false, writes: 0, reason: err.message };
    }
  })(), { ok: false, writes: 0, reason: 'timeout' }, 10000, 'saveThermalSnapshot');
}

async function sweepStaleHotspots(db: SupabaseClient, currentKeys: string[]): Promise<void> {
  const cutoffIso = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  let query = db.from(HOTSPOTS_TABLE).delete({ count: 'exact' }).lt('updated_at', cutoffIso);
  if (currentKeys.length > 0) {
    query = query.not('grid_key', 'in', `(${currentKeys.map(k => `"${k}"`).join(',')})`);
  }
  const { count, error } = await query;
  if (error) {
    console.error('[Supabase] Failed to sweep stale hotspots:', error.message);
    return;
  }
  if (count && count > 0) {
    console.log(`[Supabase] Swept ${count} stale hotspot(s) not re-detected in ${STALE_AFTER_MS / 3600000}h.`);
  }
}

// Cheap (single-row) read of how recently ANY serverless instance last
// completed a successful refresh. Vercel functions don't share in-memory
// state across instances - concurrent requests can land on separate cold
// instances that each think they're the first to refresh. The database
// acts as the one clock every instance can actually agree on, so
// ensureFreshData() checks this before starting its own live fetch.
export async function getLatestSnapshotAgeMs(): Promise<number | null> {
  const db = getClient();
  if (!db) return null;

  return withHardTimeout((async () => {
    try {
      const { data, error } = await db
        .from(HOTSPOTS_TABLE)
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return Date.now() - new Date(data.updated_at).getTime();
    } catch (err: any) {
      console.error('[Supabase] Failed to check latest snapshot age:', err.message);
      return null;
    }
  })(), null, 3000, 'getLatestSnapshotAgeMs');
}

// Reconstructs a ThermalAnomaly[] from the current snapshot - used to
// recover from a cold start with real recent data instead of the
// synthetic baseline generator, and to seed persistence tracking so
// "persistent source" status doesn't reset to false on every cold start.
export async function loadThermalSnapshot(): Promise<ThermalAnomaly[]> {
  const db = getClient();
  if (!db) return [];

  return withHardTimeout((async () => {
    try {
      const { data, error } = await db
        .from(HOTSPOTS_TABLE)
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      if (!data) return [];

      return data.map((d, idx) => {
        const nf = d.nearest_facility as any;
        const facility = nf ? GLOBAL_INDUSTRIAL_FACILITIES.find(f => f.id === nf.facilityId) : undefined;

        const anomaly: ThermalAnomaly = {
          id: `FIRMS-RESTORED-${d.grid_key}-${idx}`,
          latitude: d.latitude,
          longitude: d.longitude,
          brightness: d.brightness_kelvin,
          frp: d.frp_mw,
          scan: 1,
          track: 1,
          acq_date: d.acq_date,
          acq_time: d.acq_time,
          satellite: d.satellite,
          confidence: d.confidence,
          daynight: d.daynight,
          windSpeedKmh: d.wind_speed_kmh,
          windDirectionDeg: d.wind_direction_deg,
          nearestFacility: facility && nf
            ? {
                facility,
                distanceKm: nf.distanceKm,
                threatScore: nf.threatScore,
                threatLevel: nf.threatLevel,
                timeToImpactHours: nf.timeToImpactHours,
                windSpreadRisk: nf.windSpreadRisk
              }
            : undefined,
          classification: {
            classification: d.fire_type as FireClassification,
            confidence: d.classification_confidence,
            reasoning: d.classification_reasoning,
            isPersistent: d.is_persistent_source,
            occurrences: d.occurrences,
            landCover: d.land_cover as LandCoverType,
            firstSeenAt: d.updated_at
          }
        };
        return anomaly;
      });
    } catch (err: any) {
      console.error('[Supabase] Failed to load thermal snapshot:', err.message);
      return [];
    }
  })(), [], 5000, 'loadThermalSnapshot');
}

// Returns {gridKey, occurrences, lastSeenAt} for every stored hotspot, used
// to seed the in-memory persistence-tracking grid on a cold start.
export async function loadPersistenceSeed(): Promise<{ key: string; occurrences: number; lastSeenAt: number; frp: number }[]> {
  const db = getClient();
  if (!db) return [];

  return withHardTimeout((async () => {
    try {
      const { data, error } = await db
        .from(HOTSPOTS_TABLE)
        .select('grid_key, occurrences, updated_at, frp_mw')
        .limit(300);
      if (error) throw error;
      if (!data) return [];
      return data.map((d) => ({
        key: d.grid_key,
        occurrences: d.occurrences || 1,
        lastSeenAt: d.updated_at ? new Date(d.updated_at).getTime() : Date.now(),
        frp: d.frp_mw || 0
      }));
    } catch (err: any) {
      console.error('[Supabase] Failed to load persistence seed:', err.message);
      return [];
    }
  })(), [], 5000, 'loadPersistenceSeed');
}

// Returns the most recent alerts for the history/audit view - a durable
// record that survives cold starts, unlike the in-memory activeAlerts list.
export async function loadRecentAlerts(limit = 100): Promise<EmergencyAlert[]> {
  const db = getClient();
  if (!db) return [];

  try {
    const { data, error } = await db
      .from(ALERTS_TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    if (!data) return [];
    return data.map((d) => ({
      id: d.id,
      timestamp: d.timestamp,
      facilityId: d.facility_id,
      facilityName: d.facility_name,
      anomalyId: d.anomaly_id,
      severity: d.severity,
      title: d.title,
      message: d.message,
      distanceKm: d.distance_km,
      frpMW: d.frp_mw,
      dispatchedTo: d.dispatched_to,
      status: d.status,
      evacuationPerimeterKm: d.evacuation_perimeter_km,
      apparatusAssigned: d.apparatus_assigned
    } as EmergencyAlert));
  } catch (err: any) {
    console.error('[Supabase] Failed to load recent alerts:', err.message);
    return [];
  }
}

export async function saveAlert(alert: EmergencyAlert): Promise<void> {
  const db = getClient();
  if (!db) return;

  try {
    const { error } = await db.from(ALERTS_TABLE).upsert({
      id: alert.id,
      facility_id: alert.facilityId,
      facility_name: alert.facilityName,
      anomaly_id: alert.anomalyId,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      distance_km: alert.distanceKm,
      frp_mw: alert.frpMW,
      dispatched_to: alert.dispatchedTo,
      status: alert.status,
      evacuation_perimeter_km: alert.evacuationPerimeterKm,
      apparatus_assigned: alert.apparatusAssigned,
      timestamp: alert.timestamp
    });
    if (error) throw error;
  } catch (err: any) {
    console.error('[Supabase] Failed to save alert:', err.message);
  }
}

// Citizen fire reports - ground-truth sightings for fires too small, too
// new, or too cloud-obscured for the satellite to have picked up yet.
// Append-only, like alerts: low-volume, human-submitted, each one a
// distinct real-world event worth keeping permanently.
export async function saveFireReport(report: FireReport): Promise<void> {
  const db = getClient();
  if (!db) throw new Error('The database is not configured on this deployment.');

  const { error } = await db.from(REPORTS_TABLE).insert({
    id: report.id,
    reported_at: report.reportedAt,
    latitude: report.latitude,
    longitude: report.longitude,
    location_source: report.locationSource,
    landmark: report.landmark || null,
    description: report.description || null,
    image_base64: report.imageBase64,
    status: report.status,
    confirm_count: 0,
    dispute_count: 0
  });
  if (error) throw new Error(error.message);
}

// Lets any other viewer of the Citizen Reports tab vote on whether a
// sighting looks genuine - there's no human reviewer otherwise, so this is
// the cross-check. Goes through the increment_report_vote SQL function
// (see supabase/schema.sql) so concurrent votes from different viewers
// can't race and clobber each other the way a plain read-then-write would.
export async function voteFireReport(id: string, type: 'confirm' | 'dispute'): Promise<{ confirmCount: number; disputeCount: number } | null> {
  const db = getClient();
  if (!db) throw new Error('The database is not configured on this deployment.');

  const { data, error } = await db.rpc('increment_report_vote', { p_report_id: id, p_vote_type: type });
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;
  return { confirmCount: data[0].confirm_count, disputeCount: data[0].dispute_count };
}

export async function loadRecentFireReports(limit = 50): Promise<FireReport[]> {
  const db = getClient();
  if (!db) return [];

  try {
    const { data, error } = await db
      .from(REPORTS_TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    if (!data) return [];
    return data.map((d) => ({
      id: d.id,
      reportedAt: d.reported_at,
      latitude: d.latitude,
      longitude: d.longitude,
      locationSource: d.location_source,
      landmark: d.landmark || undefined,
      description: d.description || undefined,
      imageBase64: d.image_base64,
      status: d.status,
      confirmCount: d.confirm_count || 0,
      disputeCount: d.dispute_count || 0
    } as FireReport));
  } catch (err: any) {
    console.error('[Supabase] Failed to load fire reports:', err.message);
    return [];
  }
}
