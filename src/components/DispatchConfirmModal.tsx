import React from 'react';
import { X, Radio, Phone, AlertTriangle, Loader2 } from 'lucide-react';
import { ThermalAnomaly, IndustrialFacility } from '../types';

interface DispatchConfirmModalProps {
  anomaly: ThermalAnomaly;
  facility: IndustrialFacility;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export const DispatchConfirmModal: React.FC<DispatchConfirmModalProps> = ({ anomaly, facility, submitting, onClose, onConfirm }) => {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md">
      <div className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col text-slate-100">

        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/60 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-rose-950/70 border border-rose-500/40 text-rose-400">
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Simulate Dispatch</h2>
              <p className="text-xs text-slate-400">{facility.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          <div className="p-2.5 rounded-lg bg-amber-950/20 border border-amber-500/30 text-[11px] text-amber-300 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              This logs a mock responder assignment inside this app only - it does <strong>not</strong> contact any real
              emergency service.
            </span>
          </div>

          <div>
            <p className="text-xs font-bold text-slate-300 mb-2">Is this a real emergency?</p>
            <a
              href="tel:112"
              className="flex items-center gap-3 w-full p-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer"
            >
              <div className="p-2 rounded-full bg-white/15 flex-shrink-0">
                <Phone className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="text-lg font-black tracking-wide leading-none">112</div>
                <div className="text-[11px] text-rose-100/90 mt-0.5">India's unified emergency number - Police, Fire, Ambulance. Tap to call now.</div>
              </div>
            </a>
          </div>

          <div className="text-[11px] text-slate-500">
            {anomaly.frp.toFixed(1)} MW thermal signature, {anomaly.nearestFacility?.distanceKm.toFixed(1)} km from {facility.name}.
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 text-sm font-bold transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={submitting}
              className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-sm font-bold transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
              Log Simulated Dispatch
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
