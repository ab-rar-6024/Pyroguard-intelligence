import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { ThermalAnomaly, EmergencyAlert, FireClassification, LandCoverType, FireReport } from '../types.js';
import { gridKey } from './persistenceTracker.js';
import { GLOBAL_INDUSTRIAL_FACILITIES } from '../data/industrialDatabase.js';

// Persists PyroGuard's live data to Firebase Firestore, when configured.
//
// Storage design: thermal hotspots are stored as a CURRENT SNAPSHOT, one
// document per real-world location (keyed by the same ~5.5km grid cell used
// for in-process persistence tracking), upserted in place on every refresh
// rather than appended forever. NASA FIRMS re-detects the same fire on every
// satellite pass, so an append-only log would run into Firestore's free-tier
// write quota (20K/day) within hours. A snapshot answers "what's burning
// right now" and stays small and free. Stale hotspots (not re-detected in
// STALE_AFTER_MS) are swept on each refresh so extinguished fires don't
// linger forever.
//
// Alerts (auto-generated critical breaches + simulated dispatches) are
// naturally low-volume and are stored append-only, one document per alert.

const HOTSPOTS_COLLECTION = 'thermalHotspots';
const ALERTS_COLLECTION = 'alerts';
const REPORTS_COLLECTION = 'fireReports';
const STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours with no re-detection

let app: App | null = null;
let db: Firestore | null = null;
let initAttempted = false;

function getDb(): Firestore | null {
  if (initAttempted) return db;
  initAttempted = true;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Vercel/most env systems store multi-line keys with literal "\n" - restore real newlines.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.warn('[Firestore] Not configured (FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY missing) - fire data will not be persisted.');
    return null;
  }

  try {
    app = getApps()[0] || initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    db = getFirestore(app);
    console.log('[Firestore] Connected - persisting fire data to project', projectId);
    return db;
  } catch (err: any) {
    console.error('[Firestore] Failed to initialize:', err.message);
    return null;
  }
}

export function isFirestoreConfigured(): boolean {
  return getDb() !== null;
}

function anomalyToDoc(anomaly: ThermalAnomaly) {
  return {
    latitude: anomaly.latitude,
    longitude: anomaly.longitude,
    frpMW: anomaly.frp,
    brightnessKelvin: anomaly.brightness,
    satellite: anomaly.satellite,
    confidence: anomaly.confidence,
    acqDate: anomaly.acq_date,
    acqTime: anomaly.acq_time,
    daynight: anomaly.daynight,
    windSpeedKmh: anomaly.windSpeedKmh,
    windDirectionDeg: anomaly.windDirectionDeg,
    nearestFacility: anomaly.nearestFacility
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
    fireType: anomaly.classification?.classification || 'UNKNOWN',
    classificationConfidence: anomaly.classification?.confidence ?? null,
    classificationReasoning: anomaly.classification?.reasoning ?? null,
    isPersistentSource: anomaly.classification?.isPersistent ?? false,
    occurrences: anomaly.classification?.occurrences ?? 1,
    landCover: anomaly.classification?.landCover ?? 'unknown',
    updatedAt: Timestamp.now()
  };
}

// Upserts the current batch of classified hotspots as a snapshot, and sweeps
// any previously-stored hotspot that hasn't been re-detected recently.
export async function saveThermalSnapshot(anomalies: ThermalAnomaly[]): Promise<void> {
  const firestore = getDb();
  if (!firestore) return;

  try {
    const seenKeys = new Set<string>();
    const batch = firestore.batch();
    let writes = 0;

    for (const anomaly of anomalies) {
      const key = gridKey(anomaly.latitude, anomaly.longitude);
      seenKeys.add(key);
      batch.set(firestore.collection(HOTSPOTS_COLLECTION).doc(key), anomalyToDoc(anomaly), { merge: false });
      writes++;
    }

    if (writes > 0) {
      await batch.commit();
    }

    await sweepStaleHotspots(firestore, seenKeys);
  } catch (err: any) {
    console.error('[Firestore] Failed to save thermal snapshot:', err.message);
  }
}

async function sweepStaleHotspots(firestore: Firestore, currentKeys: Set<string>): Promise<void> {
  const cutoff = Timestamp.fromMillis(Date.now() - STALE_AFTER_MS);
  const staleSnapshot = await firestore
    .collection(HOTSPOTS_COLLECTION)
    .where('updatedAt', '<', cutoff)
    .limit(200)
    .get();

  if (staleSnapshot.empty) return;

  const batch = firestore.batch();
  let deletions = 0;
  staleSnapshot.forEach((doc) => {
    if (!currentKeys.has(doc.id)) {
      batch.delete(doc.ref);
      deletions++;
    }
  });

  if (deletions > 0) {
    await batch.commit();
    console.log(`[Firestore] Swept ${deletions} stale hotspot(s) not re-detected in ${STALE_AFTER_MS / 3600000}h.`);
  }
}

// Reconstructs a ThermalAnomaly[] from the current Firestore snapshot -
// used to recover from a cold start with real recent data instead of the
// synthetic baseline generator, and to seed persistence tracking so
// "persistent source" status doesn't reset to false on every cold start.
export async function loadThermalSnapshot(): Promise<ThermalAnomaly[]> {
  const firestore = getDb();
  if (!firestore) return [];

  try {
    const snapshot = await firestore.collection(HOTSPOTS_COLLECTION).orderBy('updatedAt', 'desc').limit(300).get();
    if (snapshot.empty) return [];

    return snapshot.docs.map((doc, idx) => {
      const d = doc.data();
      const facility = d.nearestFacility ? GLOBAL_INDUSTRIAL_FACILITIES.find(f => f.id === d.nearestFacility.facilityId) : undefined;

      const anomaly: ThermalAnomaly = {
        id: `FIRMS-RESTORED-${doc.id}-${idx}`,
        latitude: d.latitude,
        longitude: d.longitude,
        brightness: d.brightnessKelvin,
        frp: d.frpMW,
        scan: 1,
        track: 1,
        acq_date: d.acqDate,
        acq_time: d.acqTime,
        satellite: d.satellite,
        confidence: d.confidence,
        daynight: d.daynight,
        windSpeedKmh: d.windSpeedKmh,
        windDirectionDeg: d.windDirectionDeg,
        nearestFacility: facility && d.nearestFacility
          ? {
              facility,
              distanceKm: d.nearestFacility.distanceKm,
              threatScore: d.nearestFacility.threatScore,
              threatLevel: d.nearestFacility.threatLevel,
              timeToImpactHours: d.nearestFacility.timeToImpactHours,
              windSpreadRisk: d.nearestFacility.windSpreadRisk
            }
          : undefined,
        classification: {
          classification: d.fireType as FireClassification,
          confidence: d.classificationConfidence,
          reasoning: d.classificationReasoning,
          isPersistent: d.isPersistentSource,
          occurrences: d.occurrences,
          landCover: d.landCover as LandCoverType,
          firstSeenAt: d.updatedAt?.toDate?.().toISOString()
        }
      };
      return anomaly;
    });
  } catch (err: any) {
    console.error('[Firestore] Failed to load thermal snapshot:', err.message);
    return [];
  }
}

// Returns {gridKey, occurrences, lastSeenAt} for every stored hotspot, used
// to seed the in-memory persistence-tracking grid on a cold start.
export async function loadPersistenceSeed(): Promise<{ key: string; occurrences: number; lastSeenAt: number; frp: number }[]> {
  const firestore = getDb();
  if (!firestore) return [];

  try {
    const snapshot = await firestore.collection(HOTSPOTS_COLLECTION).limit(300).get();
    return snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        key: doc.id,
        occurrences: d.occurrences || 1,
        lastSeenAt: d.updatedAt?.toMillis?.() || Date.now(),
        frp: d.frpMW || 0
      };
    });
  } catch (err: any) {
    console.error('[Firestore] Failed to load persistence seed:', err.message);
    return [];
  }
}

// Returns the most recent alerts for the history/audit view - a durable
// record that survives cold starts, unlike the in-memory activeAlerts list.
export async function loadRecentAlerts(limit = 100): Promise<EmergencyAlert[]> {
  const firestore = getDb();
  if (!firestore) return [];

  try {
    const snapshot = await firestore.collection(ALERTS_COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
    return snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        timestamp: d.timestamp,
        facilityId: d.facilityId,
        facilityName: d.facilityName,
        anomalyId: d.anomalyId,
        severity: d.severity,
        title: d.title,
        message: d.message,
        distanceKm: d.distanceKm,
        frpMW: d.frpMW,
        dispatchedTo: d.dispatchedTo,
        status: d.status,
        evacuationPerimeterKm: d.evacuationPerimeterKm,
        apparatusAssigned: d.apparatusAssigned
      } as EmergencyAlert;
    });
  } catch (err: any) {
    console.error('[Firestore] Failed to load recent alerts:', err.message);
    return [];
  }
}

export async function saveAlert(alert: EmergencyAlert): Promise<void> {
  const firestore = getDb();
  if (!firestore) return;

  try {
    await firestore.collection(ALERTS_COLLECTION).doc(alert.id).set({
      facilityId: alert.facilityId,
      facilityName: alert.facilityName,
      anomalyId: alert.anomalyId,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      distanceKm: alert.distanceKm,
      frpMW: alert.frpMW,
      dispatchedTo: alert.dispatchedTo,
      status: alert.status,
      evacuationPerimeterKm: alert.evacuationPerimeterKm,
      apparatusAssigned: alert.apparatusAssigned,
      timestamp: alert.timestamp,
      createdAt: Timestamp.now()
    });
  } catch (err: any) {
    console.error('[Firestore] Failed to save alert:', err.message);
  }
}

// Citizen fire reports - ground-truth sightings for fires too small, too
// new, or too cloud-obscured for the satellite to have picked up yet.
// Append-only (one document per report, like alerts): these are
// low-volume, human-submitted, and each one is a distinct real-world
// event worth keeping permanently, not a recurring detection to collapse
// into a snapshot.
export async function saveFireReport(report: FireReport): Promise<void> {
  const firestore = getDb();
  if (!firestore) throw new Error('Firestore is not configured on this deployment.');

  await firestore.collection(REPORTS_COLLECTION).doc(report.id).set({
    reportedAt: report.reportedAt,
    latitude: report.latitude,
    longitude: report.longitude,
    locationSource: report.locationSource,
    landmark: report.landmark || null,
    description: report.description || null,
    imageBase64: report.imageBase64,
    status: report.status,
    confirmCount: 0,
    disputeCount: 0,
    createdAt: Timestamp.now()
  });
}

// Lets any other viewer of the Citizen Reports tab vote on whether a
// sighting looks genuine - there's no human reviewer otherwise, so this is
// the cross-check. FieldValue.increment is atomic, so concurrent votes
// from different viewers can't race and clobber each other.
export async function voteFireReport(id: string, type: 'confirm' | 'dispute'): Promise<{ confirmCount: number; disputeCount: number } | null> {
  const firestore = getDb();
  if (!firestore) throw new Error('Firestore is not configured on this deployment.');

  const ref = firestore.collection(REPORTS_COLLECTION).doc(id);
  const field = type === 'confirm' ? 'confirmCount' : 'disputeCount';
  await ref.update({ [field]: FieldValue.increment(1) });

  const updated = await ref.get();
  if (!updated.exists) return null;
  const d = updated.data()!;
  return { confirmCount: d.confirmCount || 0, disputeCount: d.disputeCount || 0 };
}

export async function loadRecentFireReports(limit = 50): Promise<FireReport[]> {
  const firestore = getDb();
  if (!firestore) return [];

  try {
    const snapshot = await firestore.collection(REPORTS_COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
    return snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        reportedAt: d.reportedAt,
        latitude: d.latitude,
        longitude: d.longitude,
        locationSource: d.locationSource,
        landmark: d.landmark || undefined,
        description: d.description || undefined,
        imageBase64: d.imageBase64,
        status: d.status,
        confirmCount: d.confirmCount || 0,
        disputeCount: d.disputeCount || 0
      } as FireReport;
    });
  } catch (err: any) {
    console.error('[Firestore] Failed to load fire reports:', err.message);
    return [];
  }
}
