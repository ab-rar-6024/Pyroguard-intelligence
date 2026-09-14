import React, { useEffect, useState } from 'react';
import { X, History, Database, AlertTriangle, RefreshCw } from 'lucide-react';
import { EmergencyAlert } from '../types';

interface IncidentHistoryModalProps {
  onClose: () => void;
}

export const IncidentHistoryModal: React.FC<IncidentHistoryModalProps> = ({ onClose }) => {
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<EmergencyAlert[]>([]);
  const [firestoreConfigured, setFirestoreConfigured] = useState(true);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/history/alerts');
      const data = await res.json();
      if (data.success) {
        setAlerts(data.data || []);
        setFirestoreConfigured(data.firestoreConfigured !== false);
      }
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
              <p className="text-[11px] text-slate-400">Durable record of alerts &amp; simulated dispatches - survives server restarts</p>
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

        {/* Content */}
        <div className="p-4 overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-slate-800 space-y-2">
          {!firestoreConfigured && (
            <div className="p-3 rounded-xl bg-amber-950/20 border border-amber-500/30 text-xs text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                Firestore isn't configured on this deployment, so there's no durable history yet - only the current
                session's alerts (visible in the incident feed) exist, and they'll be lost on the next restart.
                Set <code className="bg-slate-900 px-1 rounded">FIREBASE_PROJECT_ID</code>,{' '}
                <code className="bg-slate-900 px-1 rounded">FIREBASE_CLIENT_EMAIL</code>, and{' '}
                <code className="bg-slate-900 px-1 rounded">FIREBASE_PRIVATE_KEY</code> to enable it.
              </span>
            </div>
          )}

          {loading ? (
            <div className="py-12 text-center text-slate-500 text-xs">Loading history from Firestore...</div>
          ) : alerts.length === 0 ? (
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
          )}
        </div>

      </div>
    </div>
  );
};
