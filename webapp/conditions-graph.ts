// Pure SVG generation for the conditions graph.
// Takes data in, returns SVG string + layout. No DOM dependency.

import type { WaypointMeta, GraphLayout, GribFileMeta } from './types';

interface ConditionsGraphOpts {
  meta: WaypointMeta[];
  intermediateIdxs: number[];
  windSpeedMs: boolean;
  gribInfoFiles: GribFileMeta[];
  c64Palette: string[];
  forecastSkillHorizonHours: number;
  /** Convert internal value to display unit */
  toDisplay: (value: number, category: 'speed' | 'depth', forceMs?: boolean) => number;
  /** Format value with symbol */
  fmt: (value: number, category: 'speed' | 'depth', forceMs?: boolean) => { num: string; sym: string };
}

interface ConditionsGraphResult {
  svgContent: string;
  layout: GraphLayout;
  viewBox: string;
  /** Whether the wave height axis should be shown */
  hasWave: boolean;
  /** Right y-axis labels (wave) SVG — empty string if no wave data */
  waveAxisLabels: string[];
  /** Left y-axis data — empty array in SVG-only mode (rendered inline) */
  leftAxisLabels: string[];
}

export function buildConditionsGraph(opts: ConditionsGraphOpts): ConditionsGraphResult | null {
  const { meta, intermediateIdxs, windSpeedMs, gribInfoFiles, c64Palette, forecastSkillHorizonHours, toDisplay, fmt } =
    opts;

  if (meta.length < 2) return null;

  const hasWave = meta.some((m) => m.waveHeight != null);

  const VW = 820,
    VH = 200;
  const ml = windSpeedMs ? 30 : 0,
    mr = 20,
    mt = 14,
    mb = 66;
  const pr = 800;
  const pw = VW - ml - mr,
    ph = VH - mt - mb;

  const twsDisplayVals = meta.map((m) => toDisplay(m.tws, 'speed', windSpeedMs));
  const boatDisplayVals = meta.map((m) => (m.boatSpeed != null ? toDisplay(m.boatSpeed, 'speed') : null));
  const twsStep5 = windSpeedMs ? 2 : 5;
  const maxTwsDisp = Math.ceil(Math.max(...twsDisplayVals) / twsStep5) * twsStep5 || twsStep5;
  const maxBoatDisp = Math.ceil(Math.max(0, ...boatDisplayVals.filter((v): v is number => v != null)) / 5) * 5 || 5;
  const maxLeft = windSpeedMs ? maxBoatDisp : Math.max(maxTwsDisp, maxBoatDisp);
  const rawMaxWave = hasWave ? Math.max(...meta.map((m) => m.waveHeight ?? 0)) : 0;
  const maxWave = hasWave ? Math.max(1, Math.ceil(rawMaxWave * 2) / 2) : 0;

  const hasGrib = meta.some((m) => m.gribFile != null);
  const layout: GraphLayout = { VW, ml, pw, mt, ph, hasWave, hasGrib, maxLeft, maxBoatSpeed: maxBoatDisp, maxWave };

  const xOf = (i: number) => (ml + (i / (meta.length - 1)) * pw).toFixed(1);
  const yLeft = (v: number) => (mt + ph * (1 - v / maxLeft)).toFixed(1);
  const yWind = windSpeedMs ? (v: number) => (mt + ph * (1 - v / maxTwsDisp)).toFixed(1) : yLeft;
  const yWave = (v: number) => (mt + ph * (1 - v / maxWave)).toFixed(1);

  const el: string[] = [];

  // Defs
  el.push(`<defs><marker id="wdarrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
  <polygon points="0,0 5,2.5 0,5" fill="#a6adc8"/>
</marker>
<pattern id="gmSkillPat" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
  <rect width="6" height="6" fill="rgba(245,194,231,0.10)"/>
  <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(245,194,231,0.35)" stroke-width="1"/>
</pattern></defs>`);
  el.push(`<rect x="0" y="0" width="${String(VW)}" height="${String(VH)}" fill="#1e2230"/>`);

  // Low-confidence band
  if (hasGrib) {
    const refMs = Math.max(
      ...meta.map((m) => {
        const f = m.gribFile != null ? gribInfoFiles.find((g) => g.path === m.gribFile) : null;
        return f?.referenceTime != null && f.referenceTime !== '' ? new Date(f.referenceTime).getTime() : -Infinity;
      }),
    );
    if (isFinite(refMs)) {
      const cutoff = refMs + forecastSkillHorizonHours * 3600000;
      const firstOver = meta.findIndex((m) => new Date(m.time).getTime() > cutoff);
      if (firstOver >= 0) {
        const x0 = parseFloat(xOf(firstOver));
        el.push(
          `<rect x="${x0.toFixed(1)}" y="${String(mt)}" width="${(VW - mr - x0).toFixed(1)}" height="${String(ph)}" fill="url(#gmSkillPat)"/>`,
        );
        el.push(
          `<text x="${((x0 + VW - mr) / 2).toFixed(1)}" y="${String(mt + 10)}" text-anchor="middle" fill="#f5c2e7" font-size="8">low forecast confidence</text>`,
        );
      }
    }
  }

  // Left y-axis
  const twsAxisStep = windSpeedMs ? twsStep5 : maxLeft <= 15 ? 5 : 10;
  if (windSpeedMs) {
    el.push(`<text x="2" y="${String(mt - 8)}" fill="#89b4fa" font-size="9">m/s</text>`);
    for (let v = 0; v <= maxTwsDisp; v += twsAxisStep) {
      const y = parseFloat(yWind(v));
      el.push(
        `<line x1="0" y1="${y.toFixed(1)}" x2="${String(VW)}" y2="${y.toFixed(1)}" stroke="#313244" stroke-width="0.5"/>`,
      );
      el.push(`<text x="2" y="${y.toFixed(1)}" fill="#89b4fa" font-size="10">${String(v)}</text>`);
    }
    const boatSym = fmt(0, 'speed').sym;
    const boatStep = maxBoatDisp <= 15 ? 5 : 10;
    el.push(
      `<text x="${String(ml - 2)}" y="${String(mt - 8)}" text-anchor="end" fill="#fab387" font-size="9">${boatSym}</text>`,
    );
    for (let v = 0; v <= maxBoatDisp; v += boatStep) {
      const y = parseFloat(yLeft(v));
      el.push(
        `<text x="${String(ml - 2)}" y="${y.toFixed(1)}" text-anchor="end" fill="#fab387" font-size="10">${String(v)}</text>`,
      );
    }
  } else {
    const speedSym = fmt(0, 'speed').sym;
    el.push(`<text x="2" y="${String(mt - 8)}" fill="#89b4fa" font-size="9">${speedSym}</text>`);
    for (let v = 0; v <= maxLeft; v += twsAxisStep) {
      const y = parseFloat(yLeft(v));
      el.push(
        `<line x1="0" y1="${y.toFixed(1)}" x2="${String(VW)}" y2="${y.toFixed(1)}" stroke="#313244" stroke-width="0.5"/>`,
      );
      el.push(`<text x="2" y="${y.toFixed(1)}" fill="#89b4fa" font-size="10">${String(v)}</text>`);
    }
  }

  // Right y-axis (wave)
  if (hasWave) {
    const waveSym = fmt(0, 'depth').sym;
    el.push(
      `<text x="${String(pr + 2)}" y="${String(mt - 8)}" text-anchor="start" fill="#a6e3a1" font-size="9">${waveSym}</text>`,
    );
    const wStep = maxWave <= 3 ? 0.5 : 1;
    for (let v = 0; v <= maxWave + 0.001; v += wStep) {
      const y = parseFloat(yWave(v));
      const dispWave = fmt(v, 'depth');
      el.push(
        `<text x="${String(pr + 2)}" y="${y.toFixed(1)}" text-anchor="start" fill="#a6e3a1" font-size="10">${dispWave.num}</text>`,
      );
    }
    el.push(
      `<line x1="${String(pr)}" y1="${String(mt)}" x2="${String(pr)}" y2="${String(mt + ph)}" stroke="#45475a" stroke-width="1"/>`,
    );
  }

  // Axis lines
  el.push(
    `<line x1="${String(ml)}" y1="${String(mt)}" x2="${String(ml)}" y2="${String(mt + ph)}" stroke="#45475a" stroke-width="1"/>`,
  );
  el.push(
    `<line x1="${String(ml)}" y1="${String(mt + ph)}" x2="${String(pr)}" y2="${String(mt + ph)}" stroke="#45475a" stroke-width="1"/>`,
  );

  // Wind speed line
  el.push(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i is valid index from meta.map
    `<path d="${meta.map((m, i) => (i === 0 ? 'M' : 'L') + xOf(i) + ',' + yWind(twsDisplayVals[i]!)).join(' ')}" fill="none" stroke="#89b4fa" stroke-width="1" stroke-linejoin="round"/>`,
  );

  // Boat speed line
  {
    let segStart = -1;
    for (let i = 0; i <= meta.length; i++) {
      const hasData = i < meta.length && boatDisplayVals[i] != null;
      if (hasData && segStart === -1) {
        segStart = i;
      } else if (!hasData && segStart !== -1) {
        if (i - segStart >= 2) {
          const pts: string[] = [];
          for (let j = segStart; j < i; j++) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- j in [segStart, i) guaranteed valid
            pts.push((j === segStart ? 'M' : 'L') + xOf(j) + ',' + yLeft(boatDisplayVals[j]!));
          }
          el.push(`<path d="${pts.join(' ')}" fill="none" stroke="#fab387" stroke-width="1" stroke-linejoin="round"/>`);
        }
        segStart = -1;
      }
    }
  }

  // Wave height line
  if (hasWave) {
    let segStart = -1;
    for (let i = 0; i <= meta.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i < meta.length checked in condition
      const hasData = i < meta.length && meta[i]!.waveHeight != null;
      if (hasData && segStart === -1) {
        segStart = i;
      } else if (!hasData && segStart !== -1) {
        if (i - segStart >= 2) {
          const pts: string[] = [];
          for (let j = segStart; j < i; j++) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- j in [segStart, i) guaranteed valid; waveHeight non-null by segment start condition
            pts.push((j === segStart ? 'M' : 'L') + xOf(j) + ',' + yWave(meta[j]!.waveHeight!));
          }
          el.push(`<path d="${pts.join(' ')}" fill="none" stroke="#a6e3a1" stroke-width="1" stroke-linejoin="round"/>`);
        }
        segStart = -1;
      }
    }
  }

  // Per-waypoint dots, labels, direction arrows
  const labelEvery = Math.max(1, Math.ceil(meta.length / 8));
  const arrowY = mt + ph + 32;

  for (let i = 0; i < meta.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i < meta.length in loop bound
    const m = meta[i]!;
    const x = parseFloat(xOf(i));
    const d = new Date(m.time);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i < meta.length in loop bound
    el.push(`<circle cx="${String(x)}" cy="${yWind(twsDisplayVals[i]!)}" r="1.5" fill="#89b4fa"/>`);
    const bv = boatDisplayVals[i];
    if (bv != null) el.push(`<circle cx="${String(x)}" cy="${yLeft(bv)}" r="1.5" fill="#fab387"/>`);
    if (hasWave && m.waveHeight != null)
      el.push(`<circle cx="${String(x)}" cy="${yWave(m.waveHeight)}" r="1.5" fill="#a6e3a1"/>`);

    if (i === 0 || i === meta.length - 1 || i % labelEvery === 0) {
      const label =
        d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const ly = mt + ph + 12;
      el.push(
        `<text x="${String(x)}" y="${String(ly)}" text-anchor="middle" fill="#6c7086" font-size="9" transform="rotate(-30,${String(x)},${String(ly)})">${label}</text>`,
      );
    }

    const windDeg = (m.windDir + 180) % 360;
    const rad = (windDeg * Math.PI) / 180;
    const len = 9;
    const dx = Math.sin(rad) * len,
      dy = -Math.cos(rad) * len;
    el.push(
      `<line x1="${(x - dx / 2).toFixed(1)}" y1="${(arrowY - dy / 2).toFixed(1)}" x2="${(x + dx / 2).toFixed(1)}" y2="${(arrowY + dy / 2).toFixed(1)}" stroke="#a6adc8" stroke-width="1" marker-end="url(#wdarrow)"/>`,
    );
  }

  // Legend
  const lx = ml;
  el.push(`<rect x="${String(lx)}" y="3" width="10" height="10" fill="#89b4fa" rx="1"/>`);
  el.push(`<text x="${String(lx + 13)}" y="12" fill="#89b4fa" font-size="10">Wind speed</text>`);
  el.push(`<rect x="${String(lx + 90)}" y="3" width="10" height="10" fill="#fab387" rx="1"/>`);
  el.push(`<text x="${String(lx + 103)}" y="12" fill="#fab387" font-size="10">Boat speed</text>`);
  if (hasWave) {
    el.push(`<rect x="${String(lx + 185)}" y="3" width="10" height="10" fill="#a6e3a1" rx="1"/>`);
    el.push(`<text x="${String(lx + 198)}" y="12" fill="#a6e3a1" font-size="10">Wave height</text>`);
  }

  // GRIB source stripe
  if (hasGrib) {
    const stripeTop = mt + ph + 40;
    const stripeH = 8;
    for (let i = 0; i < meta.length; i++) {
      const x1 = parseFloat(xOf(i));
      const x2 = i < meta.length - 1 ? parseFloat(xOf(i + 1)) : VW;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i < meta.length in loop bound
      const filePath = meta[i]!.gribFile;
      const colorIdx = filePath != null ? gribInfoFiles.findIndex((f) => f.path === filePath) : -1;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- colorIdx is valid modulo index
      const color = colorIdx >= 0 ? c64Palette[colorIdx % c64Palette.length]! : '#45475a';
      el.push(
        `<rect x="${x1.toFixed(1)}" y="${String(stripeTop)}" width="${(x2 - x1).toFixed(1)}" height="${String(stripeH)}" fill="${color}" opacity="0.7"/>`,
      );
    }
    el.push(
      `<text x="${String(ml + 2)}" y="${String(stripeTop + stripeH + 10)}" fill="#6c7086" font-size="8">GRIB</text>`,
    );
  }

  // Intermediate waypoint markers
  for (let k = 0; k < intermediateIdxs.length; k++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- k < intermediateIdxs.length in loop bound
    const x = parseFloat(xOf(intermediateIdxs[k]!));
    el.push(
      `<line x1="${String(x)}" y1="${String(mt)}" x2="${String(x)}" y2="${String(mt + ph)}" stroke="#f5c2e7" stroke-width="1" stroke-dasharray="4,3" opacity="0.75"/>`,
    );
    el.push(
      `<text x="${String(x)}" y="${String(mt - 3)}" text-anchor="middle" font-size="8" fill="#f5c2e7">WP${String(k + 1)}</text>`,
    );
  }

  return {
    svgContent: el.join('\n'),
    layout,
    viewBox: `0 0 ${String(VW)} ${String(VH)}`,
    hasWave,
    waveAxisLabels: [],
    leftAxisLabels: [],
  };
}
