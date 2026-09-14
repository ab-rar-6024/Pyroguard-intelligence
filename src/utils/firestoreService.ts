import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { ThermalAnomaly, EmergencyAlert } from '../types.js';
import { gridKey } from './persistenceTracker.js';

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
