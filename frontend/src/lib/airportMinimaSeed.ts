import type { WeatherThresholds } from '../types'

// 공항별 초록/주황/빨강 판정 기본값 — 예전엔 여기 96개 공항 값을 직접 하드코딩해
// 두었는데, 관리자 페이지에서 WX_Minima.csv를 새로 업로드해도 프론트 재빌드 없이
// 반영되게 하려고 백엔드(app/wx_minima.py)가 계산한 값을 런타임에 받아오는 걸로
// 바꿈. App.tsx 초기화 시 setAirportMinimaSeed()로 채워짐 — 그 전까지는 빈
// 객체라 getThresholds()가 DEFAULT_THRESHOLDS로 폴백함(로딩 사이 짧은 순간만).
export let AIRPORT_MINIMA_SEED: Record<string, WeatherThresholds> = {}

export function setAirportMinimaSeed(seed: Record<string, WeatherThresholds>): void {
  AIRPORT_MINIMA_SEED = seed
}
