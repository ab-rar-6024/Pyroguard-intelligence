import React, { useEffect, useState } from 'react';
import { X, History, Database, AlertTriangle, RefreshCw, Flame, ChevronDown, Wind, MapPin, Camera, ThumbsUp, ThumbsDown } from 'lucide-react';
import { EmergencyAlert, ThermalAnomaly, FireClassification, FireReport } from '../types';
import { CLASSIFICATION_META } from '../utils/classificationDisplay';

interface IncidentHistoryModalProps {
  onClose: () => void;
}

type Tab = 'hotspots' | 'alerts' | 'reports';

// Anonymous, one-vote-per-browser soft limit for crowdsourced report
// verification - this app has no user accounts, so localStorage is the
// only client the vote can remember. Not abuse-proof, just enough to stop
// a single click from being repeatable by accident.
const VOTED_REPORTS_KEY = 'pyroguard_voted_reports';
function getVotedReports(): Record<string, 'confirm' | 'dispute'> {
  try {
    return JSON.parse(localStorage.getItem(VOTED_REPORTS_KEY) || '{}');
  } catch {
    return {};
  }
}
function setVotedReport(id: string, type: 'confirm' | 'dispute') {
  try {
    const current = getVotedReports();
    current[id] = type;
    localStorage.setItem(VOTED_REPORTS_KEY, JSON.stringify(current));
  } catch {
    // localStorage unavailable (private browsing, etc.) - vote still goes
    // through server-side, it just won't be remembered for future visits.
  }
}

// A facility beyond this distance wasn't actually used to classify the
// hotspot (see NEAR_FACILITY_KM in nasaFirmsService.ts) - it's just the
// globally-nearest record in the database, which can be thousands of km
// away in sparsely-covered regions. Treat it as unrelated past this radius
// rather than implying the hotspot is "at" that facility.
const ATTRIBUTION_KM = 20;

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compassFromDeg(deg: number): string {
  return COMPASS_POINTS[Math.round(deg / 22.5) % 16];
}

export const IncidentHistoryModal: React.FC<IncidentHistoryModalProps> = ({ onClose }) => {
  const [tab, setTab] = useState<Tab>('hotspots');
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<EmergencyAlert[]>([]);
  const [hotspots, setHotspots] = useState<ThermalAnomaly[]>([]);
  const [reports, setReports] = useState<FireReport[]>([]);
  const [byType, setByType] = useState<Record<string, number>>({});
  const [firestoreConfigured, setFirestoreConfigured] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [votedReports, setVotedReports] = useState<Record<string, 'confirm' | 'dispute'>>(() => getVotedReports());

  const handleVote = async (reportId: string, type: 'confirm' | 'dispute') => {
    if (votedReports[reportId]) return;
    setVotedReports((prev) => ({ ...prev, [reportId]: type }));
    setVotedReport(reportId, type);
    try {
      const res = await fetch(`/api/reports/fire/${reportId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
      });
      const data = await res.json();
      if (data.success) {
        setReports((prev) => prev.map((r) => (r.id === reportId ? { ...r, confirmCount: data.confirmCount, disputeCount: data.disputeCount } : r)));
      }
    } catch (e) {
      console.error('Failed to record vote:', e);
    }
  };

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const [alertsRes, hotspotsRes, reportsRes] = await Promise.all([
        fetch('/api/history/alerts').then((r) => r.json()),
        fetch('/api/history/hotspots').then((r) => r.json()),
        fetch('/api/reports/fire').then((r) => r.json())
      ]);
      if (alertsRes.success) setAlerts(alertsRes.data || []);
      if (hotspotsRes.success) {
        setHotspots(hotspotsRes.data || []);
        setByType(hotspotsRes.byType || {});
      }
      if (reportsRes.success) setReports(reportsRes.data || []);
      setFirestoreConfigured(alertsRes.firestoreConfigured !== false);
    } catch (e) {
      console.error('Failed to load incident history:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md">
      <div className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[88vh] shadow-2xl overflow-hidden flex flex-col text-slate-100 font-mono">

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/60 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-amber-950/70 border border-amber-500/40 text-amber-400">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                Incident History
                <span className="px-1.5 py-0.5 rounded text-[9px] bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center gap-1">
                  <Database className="w-2.5 h-2.5" /> Firestore
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">Durable record of fire data &amp; simulated dispatches - survives server restarts</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchHistory}
              title="Refresh"
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-amber-400 transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-amber-400' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pt-3 border-b border-slate-800 bg-slate-900/40 flex-shrink-0">
          <button
            onClick={() => setTab('hotspots')}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-t-lg border-b-2 transition-colors cursor-pointer ${
              tab === 'hotspots'
                ? 'border-amber-500 text-amber-400 bg-slate-950'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            <Flame className="w-3.5 h-3.5" /> All Fire Data ({hotspots.length})
          </button>
          <button
            onClick={() => setTab('alerts')}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-t-lg border-b-2 transition-colors cursor-pointer ${
              tab === 'alerts'
                ? 'border-amber-500 text-amber-400 bg-slate-950'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" /> Critical Alerts ({alerts.length})
          </button>
          <button
            onClick={() => setTab('reports')}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-t-lg border-b-2 transition-colors cursor-pointer ${
              tab === 'reports'
                ? 'border-amber-500 text-amber-400 bg-slate-950'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            <Camera className="w-3.5 h-3.5" /> Citizen Reports ({reports.length})
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-slate-800 space-y-2">
          {!firestoreConfigured && (
            <div className="p-3 rounded-xl bg-amber-950/20 border border-amber-500/30 text-xs text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                Firestore isn't configured on this deployment, so there's no durable history yet - only the current
                session's data (visible on the live map) exists, and it'll be lost on the next restart.
                Set <code className="bg-slate-900 px-1 rounded">FIREBASE_PROJECT_ID</code>,{' '}
                <code className="bg-slate-900 px-1 rounded">FIREBASE_CLIENT_EMAIL</code>, and{' '}
                <code className="bg-slate-900 px-1 rounded">FIREBASE_PRIVATE_KEY</code> to enable it.
              </span>
            </div>
          )}

          {loading ? (
            <div className="py-12 text-center text-slate-500 text-xs">Loading history from Firestore...</div>
          ) : tab === 'hotspots' ? (
            hotspots.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-xs">
                No fire data stored yet. Every classified thermal hotspot (industrial fire, gas flare, mining
                thermal, wildfire, agricultural burn) is saved here on each refresh.
              </div>
            ) : (
              <>
                {/* Fire type breakdown */}
                <div className="flex flex-wrap gap-1.5 pb-2 mb-1 border-b border-slate-800/60">
                  {(Object.keys(byType) as FireClassification[]).map((type) => {
                    const meta = CLASSIFICATION_META[type] || CLASSIFICATION_META.UNKNOWN;
                    return (
                      <span key={type} className={`px-2 py-1 rounded text-[10px] font-bold ${meta.badgeClass}`}>
                        {meta.emoji} {meta.label}: {byType[type]}
                      </span>
                    );
                  })}
                </div>

                {hotspots.map((h) => {
                  const meta = CLASSIFICATION_META[h.classification?.classification || 'UNKNOWN'];
                  const distanceKm = h.nearestFacility?.distanceKm;
                  const isAttributed = h.nearestFacility && typeof distanceKm === 'number' && distanceKm <= ATTRIBUTION_KM;
                  const isExpanded = expandedId === h.id;

                  return (
                    <div key={h.id} className="rounded-xl bg-slate-900/60 border border-slate-800 overflow-hidden">
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : h.id)}
                        className="w-full text-left p-3 space-y-1.5 cursor-pointer hover:bg-slate-900 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                            <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
                            {isAttributed ? h.nearestFacility!.facility.name : 'Unattributed hotspot'}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${meta.badgeClass}`}>
                            {meta.emoji} {meta.label}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500 pt-1 border-t border-slate-800/60">
                          <span>{h.latitude.toFixed(3)}, {h.longitude.toFixed(3)}</span>
                          <span>•</span>
                          <span>{h.frp.toFixed(0)} MW</span>
                          <span>•</span>
                          <span>{h.satellite}</span>
                          {h.classification?.landCover && h.classification.landCover !== 'unknown' && (
                            <>
                              <span>•</span>
                              <span className="capitalize">{h.classification.landCover}</span>
                            </>
                          )}
                          {h.classification?.isPersistent && (
                            <>
                              <span>•</span>
                              <span className="text-amber-400 font-bold">Persistent ({h.classification.occurrences}x)</span>
                            </>
                          )}
                          {typeof h.classification?.confidence === 'number' && (
                            <>
                              <span>•</span>
                              <span>{h.classification.confidence}% confidence</span>
                            </>
                          )}
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-slate-800/60 bg-slate-950/40">
                          <div className="flex items-start gap-2 text-[11px] text-slate-300">
                            <MapPin className="w-3.5 h-3.5 text-slate-500 flex-shrink-0 mt-0.5" />
                            <div>
                              <div>Lat {h.latitude.toFixed(4)}, Lon {h.longitude.toFixed(4)}</div>
                              {h.nearestFacility ? (
                                <div className="text-slate-500">
                                  {isAttributed ? 'At ' : 'Nearest facility: '}
                                  {h.nearestFacility.facility.name} ({h.nearestFacility.facility.country}) -{' '}
                                  {distanceKm!.toFixed(1)} km away
                                  {!isAttributed && ' (too far to attribute this hotspot to it)'}
                                </div>
                              ) : (
                                <div className="text-slate-500">No industrial facility on record nearby.</div>
                              )}
                            </div>
                          </div>

                          {typeof h.windSpeedKmh === 'number' && typeof h.windDirectionDeg === 'number' && (
                            <div className="flex items-start gap-2 text-[11px] text-slate-300">
                              <Wind className="w-3.5 h-3.5 text-slate-500 flex-shrink-0 mt-0.5" />
                              <div>
                                {h.windSpeedKmh.toFixed(0)} km/h from the {compassFromDeg(h.windDirectionDeg)}
                                {' '}({h.windDirectionDeg.toFixed(0)}°)
                                {h.nearestFacility?.windSpreadRisk && (
                                  <span className="text-slate-500"> - {h.nearestFacility.windSpreadRisk.toLowerCase()} relative to facility</span>
                                )}
                              </div>
                            </div>
                          )}

                          <div className="flex items-start gap-2 text-[11px] text-slate-300">
                            <Flame className="w-3.5 h-3.5 text-slate-500 flex-shrink-0 mt-0.5" />
                            <div>
                              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${meta.badgeClass}`}>
                                {meta.emoji} {meta.label}
                              </span>
                              {typeof h.classification?.confidence === 'number' && (
                                <span className="text-slate-500"> - {h.classification.confidence}% confidence</span>
                              )}
                              {h.classification?.reasoning && (
                                <p className="text-slate-400 mt-1 leading-snug">{h.classification.reasoning}</p>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
                            <span>Brightness: {h.brightness.toFixed(1)} K</span>
                            <span>•</span>
                            <span>Detected: {h.acq_date} {h.acq_time} ({h.daynight === 'D' ? 'Day' : 'Night'})</span>
                            <span>•</span>
                            <span>Confidence tag: {h.confidence}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )
          ) : tab === 'alerts' ? (
            alerts.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs">
              No incidents recorded yet. Critical breaches and simulated dispatches will appear here once they happen.
            </div>
          ) : (
            alerts.map((alert) => (
              <div
                key={alert.id}
                className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs font-bold text-slate-200">{alert.title}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                      alert.severity === 'CRITICAL'
                        ? 'bg-rose-500/20 text-rose-400 border-rose-500/40'
                        : alert.severity === 'HIGH'
                        ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                        : 'bg-slate-800 text-slate-400 border-slate-700'
                    }`}
                  >
                    {alert.severity}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">{alert.message}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500 pt-1 border-t border-slate-800/60">
                  <span>{new Date(alert.timestamp).toLocaleString()}</span>
                  <span>•</span>
                  <span>{alert.facilityName}</span>
                  <span>•</span>
                  <span>{alert.distanceKm.toFixed(1)} km / {alert.frpMW.toFixed(0)} MW</span>
                  <span>•</span>
                  <span className="text-emerald-400 font-bold">{alert.status}</span>
                </div>
              </div>
            ))
            )
          ) : reports.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs">
              No citizen reports yet. Use "Report Fire" in the navbar to log a sighting the satellite hasn't caught.
            </div>
          ) : (
            reports.map((report) => (
              <div
                key={report.id}
                className="rounded-xl bg-slate-900/60 border border-slate-800 overflow-hidden p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <Camera className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />
                    {report.landmark || 'Citizen-reported sighting'}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/40">
                    {report.status}
                  </span>
                </div>
                <div className="flex gap-3">
                  <img
                    src={report.imageBase64}
                    alt="Citizen-submitted fire sighting"
                    className="w-24 h-24 object-cover rounded-lg border border-slate-800 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0 space-y-1">
                    {report.description && (
                      <p className="text-[11px] text-slate-300 leading-snug">{report.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
                      <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {report.latitude.toFixed(4)}, {report.longitude.toFixed(4)}</span>
                      <span>•</span>
                      <span>{report.locationSource === 'gps' ? 'Live GPS location' : 'Picked on map'}</span>
                    </div>
                    <div className="text-[10px] text-slate-500">{new Date(report.reportedAt).toLocaleString()}</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1 border-t border-slate-800/60">
                  <span className="text-[10px] text-slate-500 mr-1">Does this look real?</span>
                  <button
                    onClick={() => handleVote(report.id, 'confirm')}
                    disabled={!!votedReports[report.id]}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold border transition-colors ${
                      votedReports[report.id] === 'confirm'
                        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                        : votedReports[report.id]
                        ? 'bg-slate-900 text-slate-600 border-slate-800 cursor-not-allowed'
                        : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-emerald-500/40 hover:text-emerald-400 cursor-pointer'
                    }`}
                  >
                    <ThumbsUp className="w-3 h-3" /> Looks Real ({report.confirmCount})
                  </button>
                  <button
                    onClick={() => handleVote(report.id, 'dispute')}
                    disabled={!!votedReports[report.id]}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold border transition-colors ${
                      votedReports[report.id] === 'dispute'
                        ? 'bg-rose-500/20 text-rose-400 border-rose-500/40'
                        : votedReports[report.id]
                        ? 'bg-slate-900 text-slate-600 border-slate-800 cursor-not-allowed'
                        : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-rose-500/40 hover:text-rose-400 cursor-pointer'
                    }`}
                  >
                    <ThumbsDown className="w-3 h-3" /> Doubtful ({report.disputeCount})
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

      </div>
    </div>
  );
};
