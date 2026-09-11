import React from 'react';
import { X, HelpCircle } from 'lucide-react';
import { CLASSIFICATION_META } from '../utils/classificationDisplay';
import { FireClassification } from '../types';

interface GlossaryModalProps {
  onClose: () => void;
}

const CLASSIFICATION_EXPLANATIONS: Record<FireClassification, string> = {
  INDUSTRIAL_FIRE: 'An active fire detected at or very near a known industrial site (refinery, chemical plant, etc.) — treat as a real emergency.',
  GAS_FLARE: 'A routine, continuously-burning flare stack at an oil, gas, or chemical facility. Normal operation, not an emergency.',
  MINING_THERMAL: 'Heat from mining or ore-processing activity — could be normal operations or an underground coal-seam fire.',
  WILDFIRE: 'A fire in forest or wild vegetation, away from any industrial site.',
  AGRICULTURAL_BURN: 'A fire in farmland, most likely a farmer intentionally burning crop residue.',
  UNKNOWN: 'Not enough information to confidently say what this is — worth a closer look.'
};

const TERMS: { term: string; plain: string; detail?: string }[] = [
  {
    term: 'Fire Power (FRP)',
    plain: 'How intense the heat is, measured in megawatts (MW) by satellite.',
    detail: 'Officially "Fire Radiative Power." Higher numbers mean a hotter, more energetic fire — a 5 MW detection is a small heat signature, a 150+ MW detection is a large, intense fire.'
  },
  {
    term: 'Threat Score',
    plain: 'A single 0–100 score combining how close a fire is, how strong it is, and how dangerous the nearby facility is.',
    detail: 'Higher scores mean a more urgent situation. It rolls the distance, fire power, wind direction, and the facility\'s hazard level into one number.'
  },
  {
    term: 'Severity (Critical / High / Elevated / Watch)',
    plain: 'A plain-language label for the threat score — Critical is the most urgent, Watch is the least.'
  },
  {
    term: 'Blast Radius',
    plain: 'The distance around a facility where an explosion could cause serious damage, based on what\'s stored there.'
  },
  {
    term: 'ETA (Time to Reach)',
    plain: 'The estimated time, in hours, before an advancing fire could reach the facility — based on wind speed and direction.'
  },
  {
    term: 'Wind Spread Risk',
    plain: '"Direct" means the wind is blowing the fire toward the facility (most dangerous); "Crosswind" is a side breeze; "Away" means wind is blowing it away.'
  },
  {
    term: 'Persistent Source',
    plain: 'This exact spot has shown up as "hot" across several satellite passes in a row — more likely a continuous source like a gas flare than a one-off fire.'
  },
  {
    term: 'Confidence %',
    plain: 'How sure the system is about its classification of a hotspot — not how dangerous it is.'
  }
];

export const GlossaryModal: React.FC<GlossaryModalProps> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md">
      <div className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[88vh] shadow-2xl overflow-hidden flex flex-col text-slate-100">

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/60 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-sky-950/70 border border-sky-500/40 text-sky-400">
              <HelpCircle className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">What do these terms mean?</h2>
              <p className="text-xs text-slate-400">A plain-language guide to everything on this dashboard</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 sm:p-5 overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-slate-800 space-y-6">

          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2.5">Fire Types (AI Classification)</h3>
            <div className="space-y-2">
              {(Object.keys(CLASSIFICATION_META) as FireClassification[]).map((key) => {
                const meta = CLASSIFICATION_META[key];
                return (
                  <div key={key} className="flex items-start gap-3 p-2.5 rounded-lg bg-slate-900/60 border border-slate-800">
                    <span className={`shrink-0 px-2 py-1 rounded text-xs font-bold ${meta.badgeClass}`}>
                      {meta.emoji} {meta.label}
                    </span>
                    <p className="text-sm text-slate-300 leading-snug">{CLASSIFICATION_EXPLANATIONS[key]}</p>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2.5">Key Terms</h3>
            <div className="space-y-3">
              {TERMS.map((t) => (
                <div key={t.term}>
                  <div className="text-sm font-bold text-slate-100">{t.term}</div>
                  <p className="text-sm text-slate-300 leading-snug">{t.plain}</p>
                  {t.detail && <p className="text-xs text-slate-500 leading-snug mt-0.5">{t.detail}</p>}
                </div>
              ))}
            </div>
          </section>

        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-800 bg-slate-900/60 flex-shrink-0 text-center">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-bold transition-colors cursor-pointer"
          >
            Got it
          </button>
        </div>

      </div>
    </div>
  );
};
