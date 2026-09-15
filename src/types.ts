export type AnomalySeverity = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'WATCH';

// AI/rule-based classification of what kind of thermal source a hotspot is,
// distinguishing industrial activity from natural/agricultural fires per
// SIH PS 26162 (industrial fires vs forest fires vs other natural fires).
export type FireClassification =
  | 'INDUSTRIAL_FIRE'
  | 'GAS_FLARE'
  | 'MINING_THERMAL'
  | 'WILDFIRE'
  | 'AGRICULTURAL_BURN'
  | 'URBAN_FIRE'
  | 'UNKNOWN';

// Land-cover context sourced from OpenStreetMap (Overpass API) used as a
// classification signal for hotspots with no nearby known facility.
export type LandCoverType = 'forest' | 'farmland' | 'industrial' | 'urban' | 'unknown';

export interface ThermalClassification {
  classification: FireClassification;
  confidence: number; // 0-100
  reasoning: string;
  isPersistent: boolean;
  occurrences: number;
  firstSeenAt?: string;
  landCover: LandCoverType;
}

export type IndustryType =
  | 'oil_refinery'
  | 'petrol_bunk_hub'
  | 'chemical_plant'
  | 'lng_terminal'
  | 'power_plant'
  | 'nuclear_plant'
  | 'mining_complex'
  | 'strategic_defense'
  | 'fertilizer_plant'
  | 'ammunition_depot'
  | 'manufacturing_hub'
  | 'timber_mill';

export interface IndustrialFacility {
  id: string;
  name: string;
  type: IndustryType;
  country: string;
  region: string;
  latitude: number;
  longitude: number;
  hazardLevel: 'EXTREME' | 'HIGH' | 'MODERATE';
  primaryChemicals: string[];
  fuelStorageCapacityTons: number;
  blastRadiusKm: number;
  toxicPlumeRadiusKm: number;
  emergencyContact: {
    responderUnit: string;
    phone: string;
    radioChannel: string;
    hazmatLevel: string;
  };
  status: 'NORMAL' | 'ALERT' | 'EVACUATING' | 'CRITICAL';
}

export interface ThermalAnomaly {
  id: string;
  latitude: number;
  longitude: number;
  brightness: number; // Kelvin
  bright_t31?: number; // Kelvin
  frp: number; // Fire Radiative Power in MW
  scan: number;
  track: number;
  acq_date: string;
  acq_time: string;
  satellite: 'VIIRS-SNPP' | 'VIIRS-NOAA20' | 'VIIRS-NOAA21' | 'MODIS-Terra' | 'MODIS-Aqua';
  confidence: 'nominal' | 'high' | 'critical' | 'low';
  daynight: 'D' | 'N';
  windSpeedKmh: number;
  windDirectionDeg: number;
  nearestFacility?: {
    facility: IndustrialFacility;
    distanceKm: number;
    threatScore: number; // 0 - 100
    threatLevel: AnomalySeverity;
    timeToImpactHours: number;
    windSpreadRisk: 'DIRECT' | 'CROSSWIND' | 'AWAY' | 'STAGNANT';
  };
  classification?: ThermalClassification;
}

export interface EmergencyAlert {
  id: string;
  timestamp: string;
  facilityId: string;
  facilityName: string;
  anomalyId: string;
  severity: AnomalySeverity;
  title: string;
  message: string;
  distanceKm: number;
  frpMW: number;
  dispatchedTo: string[];
  status: 'DISPATCHED' | 'ACKNOWLEDGED' | 'CONTAINED' | 'ESCALATED';
  evacuationPerimeterKm: number;
  apparatusAssigned: string[];
}

// A citizen-submitted sighting of a fire the satellite hasn't (yet, or
// ever will) pick up - VIIRS only detects thermal signatures large/hot
// enough to register, revisits a given spot a few times a day, and is
// blocked entirely by cloud cover, so a small or just-starting fire on the
// ground can go undetected. Requires a location and a photo (for someone
// reviewing it to judge whether it's genuine) - a landmark and free-text
// description are optional context.
export interface FireReport {
  id: string;
  reportedAt: string;
  latitude: number;
  longitude: number;
  locationSource: 'gps' | 'map';
  landmark?: string;
  description?: string;
  imageBase64: string;
  status: 'NEW' | 'REVIEWED' | 'DISMISSED';
  // Crowdsourced cross-check: any other viewer of the Citizen Reports tab
  // can vote on whether a sighting looks genuine, since there's no
  // authority reviewing these otherwise.
  confirmCount: number;
  disputeCount: number;
}

export interface NotificationThresholds {
  maxDistanceKm: number;
  minFrpMW: number;
  minRiskScore: number;
  autoDispatchEnabled: boolean;
  browserPushEnabled: boolean;
  repeatAlertIntervalMinutes: number;
}

export interface GISLayerConfig {
  mapStyle: 'dark' | 'satellite' | 'terrain' | 'osm' | 'nasa';
  showThermalOverlay: boolean;
  showFacilityMarkers: boolean;
  showBlastZones: boolean;
  showWindVectors: boolean;
  showEvacZones: boolean;
  showHeatmap: boolean;
  minFRPFilter: number;
  selectedFacilityType: string;
  selectedSeverity: string;
}

export interface WidgetVisibilityState {
  threatMatrix: boolean;
  liveFeed: boolean;
  frpChart: boolean;
  sectorDistribution: boolean;
  dispatchConsole: boolean;
  windSpreadPredictor: boolean;
  systemTelemetry: boolean;
  complianceStats: boolean;
}

export interface FIRMSFeedStatus {
  isRealData: boolean;
  apiKeyConfigured: boolean;
  lastSyncTime: string;
  totalLiveDetections: number;
  activeSatellites: string[];
  sourcesQueried: string[];
  statusMessage: string;
}

export interface AIAuditReport {
  timestamp: string;
  executiveSummary: string;
  criticalZonesIdentified: number;
  facilitiesUnderImmediateThreat: Array<{
    facilityName: string;
    threatLevel: string;
    distanceKm: number;
    immediateActions: string[];
  }>;
  evacuationRecommendations: string[];
  oshaviolationRisks: string[];
  generatedBy: string;
}

export type AIProvider = 'groq' | 'openrouter' | 'huggingface';

export interface AIThreatAnalysisReport {
  executiveSummary: string;
  blastRadiusEvaluation: string;
  recommendedApparatus: string[];
  mitigationDirectives: string[];
  containmentStrategy?: string;
  chemicalHazardsAssessment?: string;
}

export interface AIProviderOption {
  id: AIProvider;
  name: string;
  badge: string;
  description: string;
  defaultModel: string;
  availableModels: { id: string; name: string; isFree?: boolean }[];
  isDefault?: boolean;
}
