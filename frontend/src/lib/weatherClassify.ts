import type { MetarData, WeatherConfig, WeatherLevel, WeatherThresholds } from '../types'
import { AIRPORT_MINIMA_SEED } from './airportMinimaSeed'

export interface TextSegment {
  text: string
  level: 0 | 2 | 3
}

// 뇌우(TS) 판정 — 원문 토큰 파싱(classifyToken)과 구조화 필드 파싱(classifyLevel)
// 양쪽에서 동일하게 써서 판정 기준이 갈리지 않게 함. VC(부근)/강도(+/-) 접두사 포함.
const TS_TOKEN_RE = /^[+-]?(VC)?TS[A-Z]*$/

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
  if (TS_TOKEN_RE.test(token)) return 3
  // CB-topped 구름은 그 자체로 심각 처리하지 않음 — FEW/SCT는 하늘을 안 덮어서
  // CIG(운고) 자체가 성립하지 않으므로 DH와 비교할 대상이 아님. BKN/OVC(CB 여부
  // 무관)는 아래 ceiling 비교 로직에서 실제 고도로 판정됨.
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
  return config.airports[icao] ?? AIRPORT_MINIMA_SEED[icao] ?? config.defaults
}

/**
 * Classify weather level using user-defined thresholds.
 * Falls back to NOAA flight_category when raw values are unavailable.
 * TS in weather phenomena is always level 3 (non-negotiable safety rule).
 */
export function classifyLevel(data: MetarData, thresholds: WeatherThresholds): WeatherLevel {
  const hasTS = data.weather.some(w => TS_TOKEN_RE.test(w))
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

export interface LevelExplanation {
  level: WeatherLevel
  reason: string
}

/**
 * classifyLevel/highlightSegments와 같은 로직으로 레벨을 계산하되, MVFR/IFR
 * 같은 일반 카테고리가 아니라 실제로 그 레벨을 유발한 METAR 원문 조각을 그대로
 * 근거로 반환함(토스트 알림에 "왜 떴는지"를 보여주기 위함).
 */
export function explainLevel(data: MetarData, thresholds: WeatherThresholds): LevelExplanation {
  const segments = highlightSegments(data.raw || '', thresholds)
  const tokenLevel = segments.reduce((m, s) => Math.max(m, s.level), 0)
  const dataLevel = classifyLevel(data, thresholds)
  const level = Math.max(tokenLevel, dataLevel) as WeatherLevel

  if (level === 1) return { level, reason: '' }

  // 이 레벨을 유발한 원문 토큰들을 그대로 근거로 사용
  const triggers = segments.filter(s => s.level === level).map(s => s.text)
  if (triggers.length > 0) {
    return { level, reason: triggers.join(' ') }
  }

  // 원문 토큰에서는 못 잡았지만 구조화 필드(classifyLevel)에서만 잡힌 경우
  // (예: NOAA flight_category 폴백 — 실측 vis/ceiling 데이터 자체가 없는 관측)
  const gust = data.gust_kt ?? 0
  if (gust > thresholds.gust_caution_kt) return { level, reason: `돌풍 ${gust}kt` }
  if (data.vis_m !== null && data.vis_m < thresholds.vis_caution_m) return { level, reason: `시정 ${data.vis_m}m` }
  if (data.ceiling_ft !== null && data.ceiling_ft < thresholds.ceiling_caution_ft) return { level, reason: `운고 ${data.ceiling_ft}ft` }
  return { level, reason: `${data.flight_category} (실측 시정/운고 데이터 없음)` }
}
