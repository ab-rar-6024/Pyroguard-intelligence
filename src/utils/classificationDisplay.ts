import { FireClassification } from '../types';

export const CLASSIFICATION_META: Record<FireClassification, { label: string; short: string; emoji: string; badgeClass: string }> = {
  INDUSTRIAL_FIRE: {
    label: 'Industrial Fire',
    short: 'IND. FIRE',
    emoji: '🏭',
    badgeClass: 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
  },
  GAS_FLARE: {
    label: 'Gas Flare',
    short: 'FLARE',
    emoji: '🔥',
    badgeClass: 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
  },
  MINING_THERMAL: {
    label: 'Mining Thermal',
    short: 'MINING',
    emoji: '⛏️',
    badgeClass: 'bg-orange-500/20 text-orange-400 border border-orange-500/40'
  },
  WILDFIRE: {
    label: 'Wildfire',
    short: 'WILDFIRE',
    emoji: '🌲',
    badgeClass: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
  },
  AGRICULTURAL_BURN: {
    label: 'Agricultural Burn',
    short: 'AGRI BURN',
    emoji: '🌾',
    badgeClass: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
  },
  URBAN_FIRE: {
    label: 'Urban Fire',
    short: 'URBAN',
    emoji: '🏘️',
    badgeClass: 'bg-red-500/20 text-red-400 border border-red-500/40'
  },
  UNKNOWN: {
    label: 'Unclassified',
    short: 'UNKNOWN',
    emoji: '❓',
    badgeClass: 'bg-slate-700/40 text-slate-400 border border-slate-600/40'
  }
};

export const CLASSIFICATION_OPTIONS: { id: FireClassification | 'ALL'; label: string }[] = [
  { id: 'ALL', label: 'All Classifications' },
  { id: 'INDUSTRIAL_FIRE', label: '🏭 Industrial Fire' },
  { id: 'GAS_FLARE', label: '🔥 Gas Flare' },
  { id: 'MINING_THERMAL', label: '⛏️ Mining Thermal' },
  { id: 'WILDFIRE', label: '🌲 Wildfire' },
  { id: 'AGRICULTURAL_BURN', label: '🌾 Agricultural Burn' },
  { id: 'URBAN_FIRE', label: '🏘️ Urban Fire' },
  { id: 'UNKNOWN', label: '❓ Unclassified' }
];
