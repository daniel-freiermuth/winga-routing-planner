// Unit conversion: internal units (kn, m, nmi) ↔ SignalK display units.
// unitPrefs is set once from loadConfig and stays stable.

import { writable, get } from 'svelte/store';
import type { UnitPref, UnitCategory } from './types';

export const unitPrefsStore = writable<Record<string, UnitPref> | null>(null);
export const windSpeedMsStore = writable(false);

const _toSI: Record<UnitCategory, (v: number) => number> = {
  speed: (v) => v * 0.514444,
  depth: (v) => v,
  distance: (v) => v * 1852.001,
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for future use
const _fromSI: Record<UnitCategory, (v: number) => number> = {
  speed: (v) => v * 1.94384,
  depth: (v) => v,
  distance: (v) => v / 1852.001,
};
const _fallbackSym: Record<UnitCategory, string> = { speed: 'kn', depth: 'm', distance: 'nmi' };

function _evalFormula(formula: string, value: number): number {
  const m = /^value\s*([*/+-])\s*([\d.]+)$/.exec(formula);
  if (!m) return value;
  const op = m[1] ?? '';
  const n = parseFloat(m[2] ?? '0');
  return op === '*' ? value * n : op === '/' ? value / n : op === '+' ? value + n : value - n;
}

export function toDisplay(value: number, category: UnitCategory, forceMs = false): number {
  if (forceMs) return _toSI[category](value);
  const p = get(unitPrefsStore)?.[category];
  if (p?.formula == null || p.formula === '') return value;
  return _evalFormula(p.formula, _toSI[category](value));
}

export function fmt(value: number, category: UnitCategory, forceMs = false): { num: string; sym: string } {
  if (forceMs) return { num: _toSI[category](value).toFixed(2), sym: 'm/s' };
  const p = get(unitPrefsStore)?.[category];
  if (p?.formula == null || p.formula === '') return { num: value.toFixed(1), sym: _fallbackSym[category] };
  const raw = _evalFormula(p.formula, _toSI[category](value));
  const fmtStr = p.displayFormat ?? '';
  const dot = fmtStr.indexOf('.');
  const decimals = dot >= 0 ? fmtStr.length - dot - 1 : 0;
  return { num: raw.toFixed(decimals), sym: p.symbol ?? '' };
}
