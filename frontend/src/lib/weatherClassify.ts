import type { MetarData, WeatherConfig, WeatherLevel, WeatherThresholds } from '../types'

export interface TextSegment {
  text: string
  level: 0 | 2 | 3
}

function parseSMtoMeters(token: string): number {
  if (token === 'P6SM') return 99999
  const stripped = token.replace(/^M/, '')
  const frac = stripped.match(/^(\d+)\/(\d+)SM$/)
  if (frac) return (parseInt(frac[1]) / parseInt(frac[2])) * 1609
  const whole = stripped.match(/^(\d+)SM$/)
  if (whole) return parseInt(whole[1]) * 1609
  return 99999
}

function classifyToken(token: string, t: WeatherThresholds): 0 | 2 | 3 {
  // TS weather phenomena (thunderstorm) → always severe
  if (/^[+-]?(VC)?TS[A-Z]*$/.test(token)) return 3
  // CB-topped clouds → severe
  if (/^(FEW|SCT|BKN|OVC)\d{3}CB$/.test(token)) return 3
  // 4-digit visibility in meters (ICAO)
  if (/^\d{4}$/.test(token)) {
    const vis = parseInt(token)
    if (vis < t.vis_severe_m) return 3
    if (vis < t.vis_caution_m) return 2
    return 0
  }
  // SM visibility (US; M prefix = "less than")
  if (/^M?(\d+\/\d+|\d+)SM$/.test(token) || token === 'P6SM') {
    if (token.startsWith('M')) return 3
    const meters = parseSMtoMeters(token)
    if (meters < t.vis_severe_m) return 3
    if (meters < t.vis_caution_m) return 2
    return 0
  }
  // Cloud ceiling (BKN or OVC)
  const cm = token.match(/^(BKN|OVC)(\d{3})/)
  if (cm) {
    const ft = parseInt(cm[2]) * 100
    if (ft < t.ceiling_severe_ft) return 3
    if (ft < t.ceiling_caution_ft) return 2
    return 0
  }
  // Vertical visibility
  if (token === 'VV///') return 2
  const vv = token.match(/^VV(\d{3})$/)
  if (vv) {
    const ft = parseInt(vv[1]) * 100
    if (ft < t.ceiling_severe_ft) return 3
    if (ft < t.ceiling_caution_ft) return 2
    return 0
  }
  // Wind gust
  const gm = token.match(/G(\d{2,3})(KT|MPS)$/)
  if (gm) {
    let g = parseInt(gm[1])
    if (gm[2] === 'MPS') g = Math.round(g * 1.944)
    if (g > t.gust_severe_kt) return 3
    if (g > t.gust_caution_kt) return 2
    return 0
  }
  return 0
}

export function highlightSegments(raw: string, thresholds: WeatherThresholds): TextSegment[] {
  const result: TextSegment[] = []
  for (const part of raw.split(/(\s+)/)) {
    if (!part) continue
    result.push({
      text: part,
      level: /^\s+$/.test(part) ? 0 : classifyToken(part, thresholds),
    })
  }
  return result
}

export const DEFAULT_THRESHOLDS: WeatherThresholds = {
  vis_caution_m: 5000,
  vis_severe_m: 1500,
  ceiling_caution_ft: 1500,
  ceiling_severe_ft: 300,
  gust_caution_kt: 25,
  gust_severe_kt: 40,
}

export const DEFAULT_CONFIG: WeatherConfig = {
  defaults: DEFAULT_THRESHOLDS,
  airports: {},
}

const LS_KEY = 'weatherConfig'

export function loadConfig(): WeatherConfig {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_CONFIG
    const parsed = JSON.parse(raw) as Partial<WeatherConfig>
    return {
      defaults: { ...DEFAULT_THRESHOLDS, ...parsed.defaults },
      airports: parsed.airports ?? {},
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

export function saveConfig(config: WeatherConfig) {
  localStorage.setItem(LS_KEY, JSON.stringify(config))
}

export function getThresholds(config: WeatherConfig, icao: string): WeatherThresholds {
  return config.airports[icao] ?? config.defaults
}

/**
 * Classify weather level using user-defined thresholds.
 * Falls back to NOAA flight_category when raw values are unavailable.
 * TS in weather phenomena is always level 3 (non-negotiable safety rule).
 */
export function classifyLevel(data: MetarData, thresholds: WeatherThresholds): WeatherLevel {
  const hasTS = data.weather.some(w => w.startsWith('TS') || w.includes('+TS'))
  const gust = data.gust_kt ?? 0

  // Level 3 hard checks
  if (hasTS) return 3
  if (gust > thresholds.gust_severe_kt) return 3
  if (data.vis_m !== null && data.vis_m < thresholds.vis_severe_m) return 3
  if (data.ceiling_ft !== null && data.ceiling_ft < thresholds.ceiling_severe_ft) return 3

  // Level 2 checks
  if (gust > thresholds.gust_caution_kt) return 2
  if (data.vis_m !== null && data.vis_m < thresholds.vis_caution_m) return 2
  if (data.ceiling_ft !== null && data.ceiling_ft < thresholds.ceiling_caution_ft) return 2

  // Fallback to NOAA flight category when vis/ceiling not available
  if (data.vis_m === null && data.ceiling_ft === null) {
    if (data.flight_category === 'LIFR') return 3
    if (data.flight_category === 'IFR' || data.flight_category === 'MVFR') return 2
  }

  return 1
}
