import { FireClassification, IndustryType, LandCoverType, ThermalClassification } from '../types.js';

// Rule-based classifier that segregates industrial fires, gas flares, and
// mining thermal activity from wildfires and agricultural burning - the
// core deliverable of SIH PS 26162 ("Classification and segregation of
// Industrial fires from forest fires and other natural fires").
//
// Signals combined: proximity to a known industrial facility (and its
// sector), FRP magnitude, cross-refresh persistence (see
// persistenceTracker.ts), and OSM land-cover context (see
// landCoverService.ts) for hotspots with no nearby facility record.

const GAS_FLARE_FACILITY_TYPES: IndustryType[] = ['oil_refinery', 'lng_terminal', 'petrol_bunk_hub', 'chemical_plant'];

const CLOSE_KM = 5;
const NEAR_KM = 20;

export interface ClassifyInput {
  distanceKm?: number;
  facilityType?: IndustryType;
  facilityName?: string;
  frp: number;
  isPersistent: boolean;
  occurrences: number;
  landCover: LandCoverType;
}

export function classifyThermalAnomaly(input: ClassifyInput): ThermalClassification {
  const { distanceKm, facilityType, facilityName, frp, isPersistent, occurrences, landCover } = input;

  if (facilityType && distanceKm !== undefined && distanceKm <= NEAR_KM) {
    const proximityFactor = distanceKm <= CLOSE_KM ? 1 : 0.7;
    const result = classifyNearFacility({ distanceKm, facilityType, facilityName, frp, isPersistent, occurrences, proximityFactor });
    return { ...result, isPersistent, occurrences, landCover };
  }

  const result = classifyFarField({ frp, isPersistent, occurrences, landCover });
  return { ...result, isPersistent, occurrences, landCover };
}

function classifyNearFacility(params: {
  distanceKm: number;
  facilityType: IndustryType;
  facilityName?: string;
  frp: number;
  isPersistent: boolean;
  occurrences: number;
  proximityFactor: number;
}): { classification: FireClassification; confidence: number; reasoning: string } {
  const { distanceKm, facilityType, facilityName, frp, isPersistent, occurrences, proximityFactor } = params;
  const name = facilityName || 'a nearby industrial facility';

  if (facilityType === 'mining_complex') {
    const confidence = Math.round((70 + (isPersistent ? 15 : 0)) * proximityFactor);
    return {
      classification: 'MINING_THERMAL',
      confidence: Math.min(95, confidence),
      reasoning: `${distanceKm.toFixed(1)} km from ${name}. ${isPersistent
        ? `Recurred across ${occurrences} satellite passes, consistent with a coal-seam fire or ongoing processing heat signature.`
        : 'Thermal signature co-located with active mining/processing operations.'}`
    };
  }

  if (GAS_FLARE_FACILITY_TYPES.includes(facilityType) && isPersistent && frp >= 8 && frp <= 60) {
    const confidence = Math.round((75 + Math.min(occurrences * 3, 20)) * proximityFactor);
    return {
      classification: 'GAS_FLARE',
      confidence: Math.min(96, confidence),
      reasoning: `${distanceKm.toFixed(1)} km from ${name}. Stable ${frp.toFixed(1)} MW signature recurring across ${occurrences} passes matches a continuous flare stack rather than an uncontrolled fire.`
    };
  }

  const confidence = Math.round((65 + Math.min(frp / 10, 20)) * proximityFactor);
  return {
    classification: 'INDUSTRIAL_FIRE',
    confidence: Math.min(96, confidence),
    reasoning: `${distanceKm.toFixed(1)} km from ${name}. ${frp.toFixed(1)} MW radiative output ${isPersistent ? 'sustained over multiple passes' : 'detected in this pass'} indicates an active industrial fire event rather than routine operations.`
  };
}

function classifyFarField(params: {
  frp: number;
  isPersistent: boolean;
  occurrences: number;
  landCover: LandCoverType;
}): { classification: FireClassification; confidence: number; reasoning: string } {
  const { frp, isPersistent, occurrences, landCover } = params;

  if (landCover === 'forest') {
    return {
      classification: 'WILDFIRE',
      confidence: frp >= 80 ? 82 : 62,
      reasoning: `No industrial facility within ${NEAR_KM} km; OSM land-use confirms forested terrain. ${frp.toFixed(1)} MW output is consistent with a vegetation fire.`
    };
  }

  if (landCover === 'farmland') {
    return {
      classification: 'AGRICULTURAL_BURN',
      confidence: isPersistent ? 40 : 68,
      reasoning: isPersistent
        ? 'OSM land-use indicates cropland, but this hotspot has recurred across multiple passes, which is atypical for a controlled agricultural burn and lowers classification confidence.'
        : `OSM land-use indicates cropland. Single-pass ${frp.toFixed(1)} MW detection is consistent with crop residue or stubble burning.`
    };
  }

  if (landCover === 'industrial') {
    return {
      classification: 'INDUSTRIAL_FIRE',
      confidence: 58,
      reasoning: `OSM land-use tags this area as industrial despite no facility record in the internal database - likely an unregistered or smaller industrial site. ${frp.toFixed(1)} MW thermal output detected.`
    };
  }

  // Land cover unresolved (not queried, or the public OSM Overpass service is
  // unavailable/rate-limited - it has no SLA and this is a routine, expected
  // fallback path, not an error). Without land-cover confirmation, fall back
  // to FRP magnitude and persistence alone: a remote hotspot with no
  // facility record is overwhelmingly either a wildfire or an agricultural
  // burn in practice (a gas flare, mining fire, or industrial fire all
  // require a facility to burn at), so a moderate-FRP or recurring detection
  // still gets a real, if lower-confidence, classification instead of a
  // blanket "Unclassified".
  if (frp >= 30) {
    return {
      classification: 'WILDFIRE',
      confidence: frp >= 80 ? 55 : 45,
      reasoning: `No facility nearby and land-cover data unavailable for this location. ${frp.toFixed(1)} MW output makes an open-area vegetation fire the most likely explanation, though this is unverified without OSM confirmation.`
    };
  }

  if (isPersistent && occurrences >= 3) {
    return {
      classification: 'WILDFIRE',
      confidence: 40,
      reasoning: `Recurring low-to-moderate thermal signature (${frp.toFixed(1)} MW) across ${occurrences} passes with no nearby facility - consistent with a slow-burning or seasonal vegetation fire, though land cover couldn't be confirmed (OSM unavailable).`
    };
  }

  if (isPersistent) {
    return {
      classification: 'UNKNOWN',
      confidence: 35,
      reasoning: `Recurring low-to-moderate thermal signature (${frp.toFixed(1)} MW) with no nearby facility and unresolved land cover - could be an unregistered flare, kiln, or smoldering source. Flagged for manual review.`
    };
  }

  return {
    classification: 'UNKNOWN',
    confidence: 30,
    reasoning: `Insufficient context (no nearby facility, land-cover unresolved) to classify this single-pass ${frp.toFixed(1)} MW detection with confidence.`
  };
}
