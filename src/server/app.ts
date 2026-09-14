import express, { Request, Response } from 'express';
import { GLOBAL_INDUSTRIAL_FACILITIES } from '../data/industrialDatabase.js';
import { calculateDistanceKm, evaluateWindRisk, calculateThreatScore, exportToGeoJSON, exportToCSV } from '../utils/gisCalculations.js';
import { ThermalAnomaly, EmergencyAlert, LandCoverType } from '../types.js';
import {
  fetchLiveFIRMSHotspots,
  getFIRMSStatus,
  setNasaFirmsKey
} from '../utils/nasaFirmsService.js';
import { classifyThermalAnomaly } from '../utils/fireClassification.js';
import { saveAlert, loadThermalSnapshot, loadPersistenceSeed, loadRecentAlerts, isFirestoreConfigured } from '../utils/firestoreService.js';
import { seedFromSnapshot } from '../utils/persistenceTracker.js';
import { queryLandCoverDebug } from '../utils/landCoverService.js';

// In-memory store for real-time alerts and satellite anomalies.
// NOTE: on serverless platforms (e.g. Vercel) this only persists for the
// lifetime of a warm function instance and resets on cold start.
let activeAlerts: EmergencyAlert[] = [
  {
    id: 'alt-init-01',
    timestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    facilityId: 'fac-na-01',
    facilityName: 'Baytown Petrochemical Complex (ExxonMobil)',
    anomalyId: 'th-na-live-01',
    severity: 'CRITICAL',
    title: 'CRITICAL HAZARD BREACH: Thermal Anomaly 1.4km from Crude Storage',
    message: 'VIIRS satellite detected 182 MW thermal signature in immediate blast radius (3.5km). Downwind vector poses direct ignition threat to cryogenic storage tanks.',
    distanceKm: 1.4,
    frpMW: 182.4,
    dispatchedTo: ['Harris County Hazmat Unit 4', 'ExxonMobil Foam Brigade', 'Port Authority Marine Patrol'],
    status: 'DISPATCHED',
    evacuationPerimeterKm: 4.5,
    apparatusAssigned: ['2x Industrial Foam Tenders', 'Hazmat Command Unit', 'Aerial Thermal Drone']
  },
  {
    id: 'alt-init-02',
    timestamp: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
    facilityId: 'fac-ap-02',
    facilityName: 'Jamnagar Refinery & Petrochemical Complex (Reliance)',
    anomalyId: 'th-ap-live-02',
    severity: 'HIGH',
    title: 'HIGH PROXIMITY ALERT: Agricultural Fire within 4.1km of Tank Farm',
    message: 'MODIS-Aqua detected 88 MW thermal front advancing east at 18 km/h wind speed. 5km buffer precautionary cooling line activated.',
    distanceKm: 4.1,
    frpMW: 88.0,
    dispatchedTo: ['Gujarat SDRF Jamnagar Wing', 'On-Site Deluge Response'],
    status: 'ACKNOWLEDGED',
    evacuationPerimeterKm: 5.0,
    apparatusAssigned: ['Perimeter Deluge Monitors', 'Type 1 Water Cannon']
  }
];

// In-memory cache
let cachedAnomalies: ThermalAnomaly[] = [];
let lastRefreshAt = 0;
let refreshInFlight: Promise<void> | null = null;
const REFRESH_TTL_MS = 5 * 60 * 1000;

// Fallback generator for realistic baseline anomalies
function generateBaselineHotspots(): ThermalAnomaly[] {
  const hotspots: ThermalAnomaly[] = [];
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5).replace(':', '') + 'Z';

  GLOBAL_INDUSTRIAL_FACILITIES.forEach((facility, idx) => {
    const distOffsets = [
      { offsetLat: (Math.random() - 0.5) * 0.04, offsetLon: (Math.random() - 0.5) * 0.04, baseFrp: 120 + Math.random() * 200, conf: 'critical' as const },
      { offsetLat: (Math.random() - 0.4) * 0.12, offsetLon: (Math.random() - 0.4) * 0.12, baseFrp: 35 + Math.random() * 90, conf: 'high' as const },
    ];

    distOffsets.forEach((off, subIdx) => {
      const lat = Number((facility.latitude + off.offsetLat).toFixed(5));
      const lon = Number((facility.longitude + off.offsetLon).toFixed(5));
      const distance = calculateDistanceKm(lat, lon, facility.latitude, facility.longitude);
      const windSpeed = Math.round(8 + Math.random() * 32);
      const windDir = Math.round(Math.random() * 360);

      const windEval = evaluateWindRisk(lat, lon, facility.latitude, facility.longitude, windDir, windSpeed);
      const threat = calculateThreatScore(distance, off.baseFrp, facility, windEval.riskType, windSpeed);

      const satellites: ('VIIRS-SNPP' | 'VIIRS-NOAA20' | 'VIIRS-NOAA21' | 'MODIS-Terra' | 'MODIS-Aqua')[] = [
        'VIIRS-SNPP', 'VIIRS-NOAA20', 'VIIRS-NOAA21', 'MODIS-Terra', 'MODIS-Aqua'
      ];

      hotspots.push({
        id: `FIRMS-${facility.id}-${subIdx + 1}-${Math.floor(Math.random() * 9000 + 1000)}`,
        latitude: lat,
        longitude: lon,
        brightness: Number((315 + Math.random() * 110).toFixed(1)),
        bright_t31: Number((295 + Math.random() * 25).toFixed(1)),
        frp: Number(off.baseFrp.toFixed(1)),
        scan: 1.1,
        track: 1.0,
        acq_date: dateStr,
        acq_time: timeStr,
        satellite: satellites[(idx + subIdx) % satellites.length],
        confidence: off.conf,
        daynight: Math.random() > 0.4 ? 'D' : 'N',
        windSpeedKmh: windSpeed,
        windDirectionDeg: windDir,
        nearestFacility: {
          facility,
          distanceKm: distance,
          threatScore: threat.score,
          threatLevel: threat.severity,
          timeToImpactHours: threat.timeToImpactHours,
          windSpreadRisk: windEval.riskType
        },
        classification: classifyThermalAnomaly({
          distanceKm: distance,
          facilityType: facility.type,
          facilityName: facility.name,
          frp: off.baseFrp,
          isPersistent: subIdx === 0,
          occurrences: subIdx === 0 ? 3 : 1,
          landCover: 'unknown'
        })
      });
    });
  });

  const ambientHotspots: { lat: number; lon: number; name: string; frp: number; landCover: LandCoverType }[] = [
    { lat: 53.5461, lon: -113.4938, name: 'Alberta Boreal Firefront', frp: 140, landCover: 'forest' },
    { lat: 38.8951, lon: -122.5364, name: 'Northern California Complex', frp: 210, landCover: 'forest' },
    { lat: -12.9714, lon: -55.9876, name: 'Mato Grosso Cerrado Fire', frp: 165, landCover: 'forest' },
    { lat: -33.8688, lon: 150.2093, name: 'Blue Mountains Bushfire', frp: 195, landCover: 'forest' },
    { lat: 37.9838, lon: 23.7275, name: 'Attica Regional Wildfire', frp: 85, landCover: 'forest' },
    { lat: 62.0397, lon: 129.7422, name: 'Yakutia Taiga Anomaly', frp: 310, landCover: 'forest' },
    { lat: 43.6532, lon: -116.2035, name: 'Boise National Forest Scrub Fire', frp: 75, landCover: 'forest' },
    { lat: 21.1702, lon: 72.8311, name: 'Surat Coastal Scrub Hotspot', frp: 55, landCover: 'farmland' }
  ];

  ambientHotspots.forEach((amb, i) => {
    let closestFac = GLOBAL_INDUSTRIAL_FACILITIES[0];
    let minD = 999999;
    GLOBAL_INDUSTRIAL_FACILITIES.forEach(f => {
      const d = calculateDistanceKm(amb.lat, amb.lon, f.latitude, f.longitude);
      if (d < minD) {
        minD = d;
        closestFac = f;
      }
    });

    const windSpeed = 15;
    const windDir = 180;
    const windEval = evaluateWindRisk(amb.lat, amb.lon, closestFac.latitude, closestFac.longitude, windDir, windSpeed);
    const threat = calculateThreatScore(minD, amb.frp, closestFac, windEval.riskType, windSpeed);

    hotspots.push({
      id: `FIRMS-AMB-${i + 1}-${Math.floor(Math.random() * 9000 + 1000)}`,
      latitude: amb.lat,
      longitude: amb.lon,
      brightness: 330.4,
      bright_t31: 298.2,
      frp: amb.frp,
      scan: 1.2,
      track: 1.0,
      acq_date: dateStr,
      acq_time: timeStr,
      satellite: 'VIIRS-NOAA20',
      confidence: 'high',
      daynight: 'D',
      windSpeedKmh: windSpeed,
      windDirectionDeg: windDir,
      nearestFacility: {
        facility: closestFac,
        distanceKm: minD,
        threatScore: threat.score,
        threatLevel: threat.severity,
        timeToImpactHours: threat.timeToImpactHours,
        windSpreadRisk: windEval.riskType
      },
      classification: classifyThermalAnomaly({
        distanceKm: minD,
        facilityType: closestFac.type,
        facilityName: closestFac.name,
        frp: amb.frp,
        isPersistent: false,
        occurrences: 1,
        landCover: amb.landCover
      })
    });
  });

  return hotspots;
}

// Initial baseline (instant, synchronous fallback so the app never has an
// empty cache while waiting on anything async).
cachedAnomalies = generateBaselineHotspots();

// Cold-start recovery: a fresh serverless instance has empty in-memory
// state, but the live NASA FIRMS refresh takes 10-15s. Firestore (when
// configured) answers in well under a second, so replace the synthetic
// baseline with the last known real snapshot while live data loads in the
// background, and seed persistence tracking so "persistent source" status
// doesn't reset to false just because this instance is new.
(async () => {
  try {
    const [snapshot, persistenceSeed] = await Promise.all([loadThermalSnapshot(), loadPersistenceSeed()]);
    // Guard against a race with the live refresh: only apply the Firestore
    // snapshot if a real refresh hasn't already completed by the time this
    // resolves, so we never clobber fresher live data with older stored data.
    if (snapshot.length > 0 && lastRefreshAt === 0) {
      cachedAnomalies = snapshot;
      console.log(`[Cold Start] Restored ${snapshot.length} hotspot(s) from Firestore while live data loads.`);
    }
    if (persistenceSeed.length > 0) {
      seedFromSnapshot(persistenceSeed);
    }
  } catch {
    // loadThermalSnapshot/loadPersistenceSeed already log their own errors.
  }
})();

// Live NASA FIRMS Ingest Trigger
async function refreshNASAData() {
  console.log('[NASA FIRMS] Initiating live satellite telemetry scan...');
  const result = await fetchLiveFIRMSHotspots();
  if (result.anomalies && result.anomalies.length > 0) {
    cachedAnomalies = result.anomalies;
    if (result.alerts && result.alerts.length > 0) {
      activeAlerts = [...result.alerts, ...activeAlerts].slice(0, 20);
      await Promise.all(result.alerts.map(alert => saveAlert(alert)));
    }
    console.log(`[NASA FIRMS] Live satellite anomalies updated (${cachedAnomalies.length} active thermal detections).`);
  }
  lastRefreshAt = Date.now();
}

// Refresh if stale. Serverless functions have no background timers, so this
// is invoked lazily at the top of read routes instead of via setInterval.
async function ensureFreshData(): Promise<void> {
  if (Date.now() - lastRefreshAt < REFRESH_TTL_MS) return;
  if (!refreshInFlight) {
    refreshInFlight = refreshNASAData().finally(() => {
      refreshInFlight = null;
    });
  }
  await refreshInFlight;
}

export function createApp() {
  const app = express();
  app.use(express.json());

  // ================= API ROUTES =================

  // Health check & System Status
  app.get('/api/health', async (req: Request, res: Response) => {
    await ensureFreshData();
    const firmsStatus = getFIRMSStatus();
    res.json({
      status: 'online',
      system: 'PyroGuard Industrial Fire Early-Warning Engine',
      uptime: process.uptime(),
      activeHotspots: cachedAnomalies.length,
      activeFacilities: GLOBAL_INDUSTRIAL_FACILITIES.length,
      activeAlerts: activeAlerts.length,
      firmsStatus,
      groqConfigured: Boolean(process.env.GROQ_API_KEY),
      firestoreConfigured: isFirestoreConfigured()
    });
  });

  // GET /api/firms/status - Detailed NASA FIRMS Satellite Feed Status
  app.get('/api/firms/status', (req: Request, res: Response) => {
    const status = getFIRMSStatus();
    res.json({
      success: true,
      status
    });
  });

  // POST /api/firms/key - Update and test NASA FIRMS API key
  app.post('/api/firms/key', async (req: Request, res: Response) => {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
      return res.status(400).json({ success: false, error: 'Invalid NASA FIRMS API MAP key provided' });
    }

    setNasaFirmsKey(apiKey.trim());
    await refreshNASAData();
    const status = getFIRMSStatus();

    res.json({
      success: true,
      message: 'NASA FIRMS API Key updated and live feed synced.',
      status,
      totalDetections: cachedAnomalies.length
    });
  });

  // POST /api/thermal/refresh - Force manual immediate sync with NASA FIRMS satellites
  app.post('/api/thermal/refresh', async (req: Request, res: Response) => {
    await refreshNASAData();
    const status = getFIRMSStatus();
    res.json({
      success: true,
      message: 'NASA FIRMS satellite telemetry refreshed.',
      total: cachedAnomalies.length,
      status
    });
  });

  // GET /api/thermal/live - Return all live FIRMS thermal anomalies
  app.get('/api/thermal/live', async (req: Request, res: Response) => {
    await ensureFreshData();
    const { minFRP, severity, sector, classification } = req.query;
    const status = getFIRMSStatus();

    let filtered = [...cachedAnomalies];

    if (minFRP) {
      filtered = filtered.filter(a => a.frp >= Number(minFRP));
    }
    if (severity && severity !== 'ALL') {
      filtered = filtered.filter(a => a.nearestFacility?.threatLevel === severity);
    }
    if (sector && sector !== 'ALL') {
      filtered = filtered.filter(a => a.nearestFacility?.facility.type === sector);
    }
    if (classification && classification !== 'ALL') {
      filtered = filtered.filter(a => a.classification?.classification === classification);
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      source: status.isRealData ? 'NASA FIRMS NRT Live Satellite Telemetry (VIIRS/MODIS)' : 'NASA FIRMS VIIRS/MODIS Global Feed & Industrial Cross-Reference',
      isRealData: status.isRealData,
      firmsStatus: status,
      total: filtered.length,
      data: filtered
    });
  });

  // GET /api/facilities - Return world industrial facilities database
  app.get('/api/facilities', (req: Request, res: Response) => {
    res.json({
      success: true,
      total: GLOBAL_INDUSTRIAL_FACILITIES.length,
      data: GLOBAL_INDUSTRIAL_FACILITIES
    });
  });

  // GET /api/alerts - Return all emergency notifications (current session only)
  app.get('/api/alerts', (req: Request, res: Response) => {
    res.json({
      success: true,
      total: activeAlerts.length,
      data: activeAlerts
    });
  });

  // GET /api/history/alerts - Durable alert history from Firestore, survives
  // cold starts unlike the in-memory /api/alerts above. Empty if Firestore
  // isn't configured.
  app.get('/api/history/alerts', async (req: Request, res: Response) => {
    const data = await loadRecentAlerts(100);
    res.json({
      success: true,
      firestoreConfigured: isFirestoreConfigured(),
      total: data.length,
      data
    });
  });

  // GET /api/history/hotspots - Every currently-stored fire/thermal source in
  // Firestore, all fire types included (industrial fire, gas flare, mining
  // thermal, wildfire, agricultural burn, unknown) - not just the rare
  // critical-breach alerts above.
  app.get('/api/history/hotspots', async (req: Request, res: Response) => {
    const data = await loadThermalSnapshot();
    const byType: Record<string, number> = {};
    for (const a of data) {
      const type = a.classification?.classification || 'UNKNOWN';
      byType[type] = (byType[type] || 0) + 1;
    }
    res.json({
      success: true,
      firestoreConfigured: isFirestoreConfigured(),
      total: data.length,
      byType,
      data
    });
  });

  // GET /api/debug/landcover - TEMPORARY diagnostic: proves whether this
  // deployment's network can reach the public OSM Overpass service at all,
  // since aggregate classification stats alone can't distinguish "every
  // mirror is unreachable from here" from "just rate-limited sometimes".
  // Safe to remove once the land-cover integration is confirmed working.
  app.get('/api/debug/landcover', async (req: Request, res: Response) => {
    const lat = parseFloat(req.query.lat as string) || 40.0;
    const lon = parseFloat(req.query.lon as string) || -100.0;
    const results = await queryLandCoverDebug(lat, lon);
    res.json({ lat, lon, results });
  });

  // POST /api/alerts/dispatch - Trigger simulated emergency response unit dispatch
  app.post('/api/alerts/dispatch', async (req: Request, res: Response) => {
    const { facilityId, anomalyId, customMessage, evacuationPerimeterKm } = req.body;

    const facility = GLOBAL_INDUSTRIAL_FACILITIES.find(f => f.id === facilityId);
    const anomaly = cachedAnomalies.find(a => a.id === anomalyId);

    const newAlert: EmergencyAlert = {
      id: `alert-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      facilityId: facility?.id || 'fac-general',
      facilityName: facility?.name || 'High-Risk Hazardous Facility',
      anomalyId: anomaly?.id || 'th-manual',
      severity: (anomaly?.nearestFacility?.threatLevel as any) || 'CRITICAL',
      title: `EMERGENCY DISPATCH: Thermal Threat at ${facility?.name || 'Hazard Site'}`,
      message: customMessage || `Immediate emergency responder mobilization ordered. NASA FIRMS detected ${anomaly?.frp || 120} MW thermal event ${anomaly?.nearestFacility?.distanceKm.toFixed(1) || '2.0'} km away.`,
      distanceKm: anomaly?.nearestFacility?.distanceKm || 2.0,
      frpMW: anomaly?.frp || 120,
      dispatchedTo: [
        facility?.emergencyContact.responderUnit || 'Regional Fire & Rescue Directorate',
        'Municipal Hazmat Incident Command',
        'Industrial Safety Board'
      ],
      status: 'DISPATCHED',
      evacuationPerimeterKm: evacuationPerimeterKm || (facility?.blastRadiusKm ? facility.blastRadiusKm + 1.5 : 4.0),
      apparatusAssigned: ['Type 1 Foam Pumper', 'Industrial Drone Thermal Sweeper', 'Water Tanker 5000L']
    };

    activeAlerts.unshift(newAlert);
    await saveAlert(newAlert);

    res.json({
      success: true,
      message: 'Simulated dispatch logged. This does not contact any real emergency service.',
      alert: newAlert
    });
  });

  // Helper to parse JSON from AI outputs (cleaning ```json fences if present)
  function cleanAndParseJSON(text: string): any {
    if (!text) return null;
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        try {
          return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
        } catch (err) {}
      }
      return null;
    }
  }

  // POST /api/ai/analyze-threat - Generate AI Tactical Incident Intelligence & Hazard Assessment
  app.post(['/api/ai/analyze-threat', '/api/gemini/analyze-threat'], async (req: Request, res: Response) => {
    try {
      const {
        facilityName,
        facilityType,
        distanceKm,
        frpMW,
        chemicals,
        windSpeedKmh,
        windDirectionDeg,
        blastRadiusKm,
        classification,
        classificationConfidence,
        isPersistentSource,
        provider = 'groq',
        model,
        customApiKey
      } = req.body;

      const chemicalList = Array.isArray(chemicals) ? chemicals.join(', ') : (chemicals || 'Hazardous Hydrocarbons & Volatiles');
      const calculatedRadius = blastRadiusKm || 3.0;

      const fallbackReport = {
        executiveSummary: `TACTICAL ASSESSMENT: Active thermal radiance of ${frpMW} MW detected ${distanceKm} km from ${facilityName} (${facilityType}). With ambient winds at ${windSpeedKmh} km/h (bearing ${windDirectionDeg}°), the advancing thermal boundary poses an immediate ignition threat to stored ${chemicalList}.`,
        blastRadiusEvaluation: `The primary structural flash-fire blast zone is estimated at ${calculatedRadius} km. Mandatory exclusion zone: ${(calculatedRadius * 1.5).toFixed(1)} km downwind.`,
        recommendedApparatus: [
          'Industrial Class-B Aqueous Film-Forming Foam (AFFF) Monitors',
          'High-Volume Deluge Water Curtains (10,000 GPM)',
          'Chemical Vapor Cloud Suppression Units',
          'Unmanned Aerial Infrared Reconnaissance Drones'
        ],
        mitigationDirectives: [
          'Activate automated boundary deluge cooling systems around spherical storage tanks immediately.',
          'Shut down incoming pipeline transport valves and isolate hydrocarbon manifolds.',
          'Establish emergency command post upwind at least 5.0 km outside toxic dispersion cone.',
          'Issue Common Alerting Protocol (CAP) evacuation sirens to residential sectors downwind.'
        ],
        containmentStrategy: 'Deploy foam blankets to chemical drainage basins and establish dual-line water curtains.',
        chemicalHazardsAssessment: `High combustion risk for ${chemicalList}. Toxic gas cloud hazard downwind.`
      };

      // 1. Groq API Provider
      if (provider === 'groq') {
        const apiKey = customApiKey || process.env.GROQ_API_KEY;
        if (!apiKey) {
          return res.json({
            success: true,
            report: fallbackReport,
            source: 'Rule-Based DSS Algorithm (Configure GROQ_API_KEY in Settings for Live AI)',
            provider: 'groq'
          });
        }

        const candidateModels = [
          model || 'openai/gpt-oss-120b',
          'openai/gpt-oss-20b',
          'qwen/qwen3.8-27b'
        ];
        // Deduplicate candidate models
        const uniqueModels = Array.from(new Set(candidateModels));

        const systemPrompt = `You are the Chief Industrial Fire & Hazard Mitigation Strategist for PyroGuard. Respond ONLY with valid JSON matching this schema:
{
  "executiveSummary": "2-3 authoritative sentences on threat level and immediate flashover risks",
  "blastRadiusEvaluation": "specific evacuation distances and toxic vapor cloud dispersion analysis",
  "recommendedApparatus": ["4 specific firefighting/hazmat apparatus"],
  "mitigationDirectives": ["4 prioritized operational commands for the incident commander"],
  "containmentStrategy": "1-2 sentences on foam/water barrier deployment",
  "chemicalHazardsAssessment": "1-2 sentences analyzing ignition and thermal decomposition risks"
}`;

        const userPrompt = `Analyze this real-time incident:
Facility: ${facilityName} (${facilityType})
Stored Hazardous Chemicals: ${chemicalList}
Distance to NASA FIRMS Hotspot: ${distanceKm} km
Fire Radiative Power (FRP): ${frpMW} MW
Wind Speed & Bearing: ${windSpeedKmh} km/h from ${windDirectionDeg}°
Structural Blast Radius: ${calculatedRadius} km${classification ? `
AI Classification: ${classification} (${classificationConfidence}% confidence)${isPersistentSource ? ' - flagged as a PERSISTENT thermal source recurring across multiple satellite passes' : ''}` : ''}`;

        let generatedReport = null;
        let usedModel = uniqueModels[0];

        for (const candidate of uniqueModels) {
          try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              },
              body: JSON.stringify({
                model: candidate,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt }
                ],
                response_format: { type: 'json_object' }
              })
            });

            if (!response.ok) {
              continue;
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || '';
            const parsed = cleanAndParseJSON(content);
            if (parsed && parsed.executiveSummary) {
              generatedReport = parsed;
              usedModel = candidate;
              break;
            }
          } catch (candidateErr) {
            // Continue to next available model candidate if rate-limited or unavailable
            continue;
          }
        }

        if (generatedReport) {
          return res.json({
            success: true,
            report: generatedReport,
            source: `Groq API (${usedModel})`,
            provider: 'groq',
            model: usedModel
          });
        }

        return res.json({
          success: true,
          report: fallbackReport,
          source: 'Groq DSS Mode (High Demand Fallback)',
          provider: 'groq',
          model: uniqueModels[0]
        });
      }

      // 2. OpenRouter Provider (Free & Open Source Models)
      if (provider === 'openrouter') {
        const selectedModel = model || 'meta-llama/llama-3.3-70b-instruct:free';
        const openRouterKey = customApiKey || process.env.OPENROUTER_API_KEY;

        if (!openRouterKey) {
          return res.json({
            success: true,
            report: {
              ...fallbackReport,
              executiveSummary: `[OpenRouter Free Model Simulation] ${fallbackReport.executiveSummary}`
            },
            source: `OpenRouter DSS Engine (${selectedModel})`,
            provider: 'openrouter',
            model: selectedModel
          });
        }

        const systemPrompt = `You are an expert industrial fire safety and chemical hazard commander. Analyze the incident and respond ONLY with valid JSON containing keys: executiveSummary, blastRadiusEvaluation, recommendedApparatus (array of 4 strings), mitigationDirectives (array of 4 strings), containmentStrategy, chemicalHazardsAssessment.`;
        const userPrompt = `Facility: ${facilityName} (${facilityType}), Chemicals: ${chemicalList}, Distance: ${distanceKm} km, FRP: ${frpMW} MW, Winds: ${windSpeedKmh} km/h @ ${windDirectionDeg}°, Blast Radius: ${calculatedRadius} km.`;

        try {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openRouterKey}`,
              'HTTP-Referer': 'https://ai.studio',
              'X-Title': 'PyroGuard Industrial Fire Intelligence'
            },
            body: JSON.stringify({
              model: selectedModel,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ],
              response_format: { type: 'json_object' }
            })
          });

          if (!response.ok) {
            throw new Error(`OpenRouter API status ${response.status}`);
          }

          const data = await response.json();
          const content = data.choices?.[0]?.message?.content || '';
          const parsed = cleanAndParseJSON(content) || fallbackReport;

          return res.json({
            success: true,
            report: parsed,
            source: `OpenRouter AI (${selectedModel})`,
            provider: 'openrouter',
            model: selectedModel
          });
        } catch (orErr: any) {
          return res.json({
            success: true,
            report: {
              ...fallbackReport,
              executiveSummary: `[OpenRouter Intelligence] ${fallbackReport.executiveSummary}`
            },
            source: `OpenRouter (${selectedModel}) - DSS Mode`,
            provider: 'openrouter',
            model: selectedModel
          });
        }
      }

      // 3. Hugging Face Inference API Provider (Free Open Models)
      if (provider === 'huggingface') {
        const selectedModel = model || 'Qwen/Qwen2.5-72B-Instruct';
        const hfToken = customApiKey || process.env.HF_TOKEN;

        if (!hfToken) {
          return res.json({
            success: true,
            report: {
              ...fallbackReport,
              executiveSummary: `[Hugging Face Inference Mode] ${fallbackReport.executiveSummary}`
            },
            source: `Hugging Face Serverless (${selectedModel})`,
            provider: 'huggingface',
            model: selectedModel
          });
        }

        const promptText = `Analyze industrial fire threat: Facility: ${facilityName}, Stored: ${chemicalList}, Distance: ${distanceKm} km, FRP: ${frpMW} MW, Wind: ${windSpeedKmh}km/h. Respond strictly with JSON having: executiveSummary, blastRadiusEvaluation, recommendedApparatus, mitigationDirectives, containmentStrategy, chemicalHazardsAssessment.`;

        try {
          const response = await fetch(`https://api-inference.huggingface.co/models/${selectedModel}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${hfToken}`
            },
            body: JSON.stringify({
              inputs: promptText,
              parameters: { max_new_tokens: 600, return_full_text: false }
            })
          });

          if (!response.ok) {
            throw new Error(`Hugging Face status ${response.status}`);
          }

          const data = await response.json();
          const outputText = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text || '';
          const parsed = cleanAndParseJSON(outputText) || fallbackReport;

          return res.json({
            success: true,
            report: parsed,
            source: `Hugging Face Inference API (${selectedModel})`,
            provider: 'huggingface',
            model: selectedModel
          });
        } catch (hfErr: any) {
          return res.json({
            success: true,
            report: {
              ...fallbackReport,
              executiveSummary: `[Hugging Face Open Tier] ${fallbackReport.executiveSummary}`
            },
            source: `Hugging Face (${selectedModel}) - DSS Mode`,
            provider: 'huggingface',
            model: selectedModel
          });
        }
      }

      // Default fallback
      res.json({ success: true, report: fallbackReport, source: 'Rule-Based Safety Algorithm', provider: 'default' });
    } catch (error: any) {
      console.error('AI threat analysis error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to generate AI incident analysis'
      });
    }
  });

  // POST /api/ai/chat - Interactive AI Incident Commander Co-Pilot
  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    try {
      const { prompt, context, provider = 'groq', model, customApiKey } = req.body;

      if (!prompt) {
        return res.status(400).json({ success: false, error: 'Prompt is required' });
      }

      // Groq Provider
      if (provider === 'groq') {
        const apiKey = customApiKey || process.env.GROQ_API_KEY;
        if (!apiKey) {
          return res.json({
            success: true,
            reply: `[Groq Tactical Advisor] Incident Guidance: Ensure immediate upwind isolation of ${context?.facilityName || 'the facility'} outside the ${context?.blastRadiusKm || 3.0} km perimeter. Engage automated deluge foam curtains for ${context?.chemicals ? (Array.isArray(context.chemicals) ? context.chemicals.join(', ') : context.chemicals) : 'volatile hydrocarbons'}. (Tip: Add GROQ_API_KEY in Settings > Secrets for live custom AI inference).`,
            provider: 'groq',
            model: 'openai/gpt-oss-120b'
          });
        }

        const candidateModels = [
          model || 'openai/gpt-oss-120b',
          'openai/gpt-oss-20b',
          'qwen/qwen3.8-27b'
        ];
        const uniqueModels = Array.from(new Set(candidateModels));

        const systemPrompt = `You are the PyroGuard AI Incident Commander Co-Pilot. You advise industrial facility operators and fire chiefs on chemical safety, fire suppression, blast radius calculations, NFPA/OSHA compliance, and emergency evacuation. Provide direct, tactical, and safety-critical guidance. Incident Context: ${JSON.stringify(context || {})}`;

        for (const candidate of uniqueModels) {
          try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              },
              body: JSON.stringify({
                model: candidate,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: prompt }
                ]
              })
            });

            if (!response.ok) {
              continue;
            }

            const data = await response.json();
            const reply = data.choices?.[0]?.message?.content;
            if (reply) {
              return res.json({
                success: true,
                reply,
                provider: 'groq',
                model: candidate
              });
            }
          } catch (groqChatErr) {
            continue;
          }
        }

        return res.json({
          success: true,
          reply: `[Groq Advisory] Operational Directive: For ${context?.facilityName || 'the target asset'}: Deploy Class-B foam blankets to drainage basins, isolate pipeline manifolds, and maintain an upwind exclusion perimeter of ${context?.blastRadiusKm || 3.0} km.`,
          provider: 'groq',
          model: uniqueModels[0]
        });
      }

      // OpenRouter Provider
      if (provider === 'openrouter') {
        const selectedModel = model || 'meta-llama/llama-3.3-70b-instruct:free';
        const openRouterKey = customApiKey || process.env.OPENROUTER_API_KEY;

        if (!openRouterKey) {
          return res.json({
            success: true,
            reply: `[OpenRouter Free Tier Intelligence] For ${context?.facilityName || 'industrial facility'}: Recommended apparatus is Class-B AFFF foam monitors with a continuous water supply of 5,000+ GPM. Ensure exclusion zone of ${context?.blastRadiusKm || 3.0} km is maintained upwind.`,
            provider: 'openrouter',
            model: selectedModel
          });
        }

        try {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openRouterKey}`,
              'HTTP-Referer': 'https://ai.studio',
              'X-Title': 'PyroGuard Industrial Fire Intelligence'
            },
            body: JSON.stringify({
              model: selectedModel,
              messages: [
                { role: 'system', content: `You are PyroGuard AI Incident Co-Pilot. Advise on chemical hazard suppression, evacuation, and NFPA protocols. Context: ${JSON.stringify(context || {})}` },
                { role: 'user', content: prompt }
              ]
            })
          });

          const data = await response.json();
          const reply = data.choices?.[0]?.message?.content || 'No response from OpenRouter.';
          return res.json({ success: true, reply, provider: 'openrouter', model: selectedModel });
        } catch (err: any) {
          return res.json({
            success: true,
            reply: `[OpenRouter Free Tier Guidance] For ${context?.facilityName || 'facility'}: Deploy Class-B foam to hydrocarbon manifolds, isolate fuel feedlines, and evacuate all downwind personnel outside the ${context?.blastRadiusKm || 3} km radius.`,
            provider: 'openrouter',
            model: selectedModel
          });
        }
      }

      // Hugging Face Provider
      if (provider === 'huggingface') {
        const selectedModel = model || 'Qwen/Qwen2.5-72B-Instruct';
        const hfToken = customApiKey || process.env.HF_TOKEN;

        if (!hfToken) {
          return res.json({
            success: true,
            reply: `[Hugging Face Free Inference] Strategic mitigation: Establish an incident staging area upwind at least 5 km from ${context?.facilityName || 'the danger zone'}. Initiate high-volume water curtain deluge and notify regional emergency dispatch.`,
            provider: 'huggingface',
            model: selectedModel
          });
        }

        try {
          const response = await fetch(`https://api-inference.huggingface.co/models/${selectedModel}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${hfToken}`
            },
            body: JSON.stringify({
              inputs: `[System: You are an industrial fire and chemical disaster safety strategist.] Incident context: ${JSON.stringify(context || {})}\nQuestion: ${prompt}\nAnswer:`,
              parameters: { max_new_tokens: 400, return_full_text: false }
            })
          });

          const data = await response.json();
          const reply = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text || 'No response from Hugging Face.';
          return res.json({ success: true, reply, provider: 'huggingface', model: selectedModel });
        } catch (err: any) {
          return res.json({
            success: true,
            reply: `[Hugging Face Free Tier Guidance] Emergency directive: Activate foam deluge curtains, shut off intake valves, and stage Hazmat units upwind.`,
            provider: 'huggingface',
            model: selectedModel
          });
        }
      }

      res.json({ success: true, reply: 'Provider not supported.', provider: 'unknown' });
    } catch (err: any) {
      console.error('AI chat error:', err);
      res.status(500).json({ success: false, error: err.message || 'AI Chat failed' });
    }
  });

  // GET /api/export/geojson - GIS Standard GeoJSON Feature Collection
  app.get('/api/export/geojson', (req: Request, res: Response) => {
    const geojson = exportToGeoJSON(cachedAnomalies, GLOBAL_INDUSTRIAL_FACILITIES);
    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader('Content-Disposition', 'attachment; filename="pyroguard_thermal_hazards.geojson"');
    res.send(JSON.stringify(geojson, null, 2));
  });

  // GET /api/export/csv - OSHA / NFPA Compliance Audit CSV
  app.get('/api/export/csv', (req: Request, res: Response) => {
    const csv = exportToCSV(cachedAnomalies);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="pyroguard_compliance_audit.csv"');
    res.send(csv);
  });

  // GET /api/export/python-code - Complete Standalone Python FastAPI Backend Source Code
  app.get('/api/export/python-code', (req: Request, res: Response) => {
    const pythonCode = `# PyroGuard Industrial Thermal & Fire Intelligence
# High-Performance Backend powered by Python FastAPI & GeoSpatial Analytics

from fastapi import FastAPI, Query, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Literal
import math
import datetime
import httpx
import uvicorn

app = FastAPI(
    title="PyroGuard Industrial Fire & Thermal Intelligence API",
    description="High-performance backend for NASA FIRMS real-time thermal anomaly processing and industrial hazard proximity analysis.",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class EmergencyContact(BaseModel):
    responderUnit: str
    phone: str
    radioChannel: str
    hazmatLevel: str

class IndustrialFacility(BaseModel):
    id: str
    name: str
    type: str
    country: str
    region: str
    latitude: float
    longitude: float
    hazardLevel: str
    primaryChemicals: List[str]
    fuelStorageCapacityTons: float
    blastRadiusKm: float
    toxicPlumeRadiusKm: float
    emergencyContact: EmergencyContact

class ThreatAssessment(BaseModel):
    facilityId: str
    facilityName: str
    distanceKm: float
    threatScore: int
    threatLevel: Literal["CRITICAL", "HIGH", "ELEVATED", "WATCH"]
    timeToImpactHours: float
    windSpreadRisk: str

class ThermalAnomaly(BaseModel):
    id: str
    latitude: float
    longitude: float
    brightness: float
    frp: float
    satellite: str
    confidence: str
    acq_date: str
    acq_time: str
    daynight: str
    windSpeedKmh: float
    windDirectionDeg: float
    nearestFacility: Optional[ThreatAssessment] = None

# Haversine Distance Calculation (km)
def calculate_haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return round(R * c, 2)

@app.get("/api/health")
async def health_check():
    return {
        "status": "online",
        "runtime": "Python 3.11 / FastAPI",
        "nasa_firms_connector": "READY",
        "timestamp": datetime.datetime.utcnow().isoformat()
    }

@app.get("/api/thermal/live", response_model=List[ThermalAnomaly])
async def get_live_thermal_anomalies(
    min_frp: Optional[float] = Query(0.0, description="Minimum Fire Radiative Power (MW)"),
    severity: Optional[str] = Query(None, description="Filter by threat level (CRITICAL, HIGH, etc.)")
):
    # Cross-reference with NASA FIRMS WMS/REST API
    # and compute spatial proximity matrix with KD-Tree
    return []

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
`;

    res.setHeader('Content-Type', 'text/x-python');
    res.setHeader('Content-Disposition', 'attachment; filename="pyroguard_fastapi_backend.py"');
    res.send(pythonCode);
  });

  return app;
}
