export type WeatherLevel = 1 | 2 | 3

export interface MetarData {
  icao: string
  raw: string
  taf_raw: string | null
  level: WeatherLevel
  flight_category: string
  vis_m: number | null
  ceiling_ft: number | null
  wind_kt: number | null
  gust_kt: number | null
  weather: string[]
  temp_c: number | null
  dewpoint_c: number | null
  qnh_hpa: number | null
  obs_time: string
}

export interface WeatherAlert {
  id: string
  icao: string
  level: WeatherLevel
  message: string
  time: string
}

export interface WeatherThresholds {
  vis_caution_m: number       // 시정 주의 기준 (m)
  vis_severe_m: number        // 시정 심각 기준 (m)
  ceiling_caution_ft: number  // 운고 주의 기준 (ft)
  ceiling_severe_ft: number   // 운고 심각 기준 (ft)
  gust_caution_kt: number     // 돌풍 주의 기준 (kt)
  gust_severe_kt: number      // 돌풍 심각 기준 (kt)
}

export interface WeatherConfig {
  defaults: WeatherThresholds
  airports: Record<string, WeatherThresholds>  // 공항별 override (ICAO → thresholds)
}

export interface RouteMeta {
  id: number
  origin: string
  destination: string
  number: number
  route: string
  distance: number
  disabled: boolean
  aircraft: string
  comments: string
}

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJSONFeature[]
}

// FOIS(국토부 항공정보포털)에 실제 제출된 ATC 비행계획 기준 스케줄 — 항공사 무관,
// 우리 항로 DB 저장 여부와도 무관하게 그날 실제 신청된 편 그대로
export interface FoisFlight {
  callsign: string
  dep: string | null
  arr: string | null
  ac_type: string | null
  reg: string | null
  sched_time: string | null
  etd: string | null
  atd: string | null
  dep_status: string | null
  nature: string | null
  sta: string | null
  eta: string | null
  ata: string | null
  ams_rec_pk: number | null
}

// 특정 편의 실제 제출 FPL을 파싱한 항로 — 지도 오버레이용
export interface FoisRoute {
  dep?: string
  arr?: string
  coordinates?: [number, number][]
  legs?: { airway: string; coords: [number, number][] }[]
  waypoints?: { id: string; lon: number; lat: number }[]
  airway_gaps?: string[]
  route?: string        // 고도/속도 변경값 등을 뗀 항로 부분만 (출발-경유-도착)
  route_raw?: string
  eet?: string | null  // FPL 신고 총 예상비행시간, "HHMM" 형식
  error?: string
}

// 지도에 오버레이 중인 FOIS 실제 항로 — ams_rec_pk로 키잉해서 편별 토글.
// color는 항공사 CI 색(lib/airlineColors)으로 지정해서 어느 항공사인지 한눈에 구분되게 함
export interface FoisOverlayRoute {
  ams_rec_pk: number
  callsign: string
  dep: string
  arr: string
  ac_type: string | null
  eet: string | null       // FPL 신고 총 예상비행시간, "HHMM" 형식 — 실측이 아니라 신고값
  route: string | null     // 고도/속도 변경값 등을 뗀 항로 부분만
  coordinates: [number, number][]
  legs: { airway: string; coords: [number, number][] }[]
  waypoints: { id: string; lon: number; lat: number }[]
  color: string
}

export interface GeoJSONFeature {
  type: 'Feature'
  geometry: {
    type: string
    coordinates: number[] | number[][] | number[][][]
  }
  properties: Record<string, unknown>
}

export interface SearchResult {
  type: 'airport' | 'airway' | 'waypoint'
  id: string
  name: string
  lat: number | null
  lon: number | null
  description: string
}

export interface AircraftState {
  icao24: string
  callsign: string
  lon: number
  lat: number
  altitude_m: number | null
  on_ground: boolean
  velocity_ms: number | null
  heading: number | null
  vertical_rate: number | null
  is_jja: boolean
}

export interface CurfewInfo {
  icao: string
  start: string     // e.g. "23:00"
  end: string       // e.g. "06:00"
  timezone: string  // e.g. "Asia/Tokyo"
  note: string
}

export type AirportTab = 'weather' | 'runway' | 'approach' | 'schedule'

export interface RunwayInfo {
  id: string
  bearing_m: number
  length_ft: number
  width_ft: number
  elevation_ft: number
  threshold_disp_ft: number
}

export interface ILSInfo {
  id: string
  frequency: string
  bearing_m: number
  category: string
}

export interface ApproachProc {
  procedure: string
  type: string       // 'ILS' | 'LPV' | 'RNP' | 'VOR' | 'NDB' | ...
  type_code: string  // 'I' | 'L' | 'R' | 'V' | 'N' | ...
  runway: string
  rnp_ar: boolean
  ils: ILSInfo | null
}

export interface AirportDetail {
  icao: string
  name: string
  lat: number
  lon: number
  elevation_ft: number
  runways: RunwayInfo[]
  approaches: ApproachProc[]
}

// ─── Weather trend / history ───────────────────────────────────────────────

export interface MetarPoint {
  obs_time: string
  wdir: number | null
  wspd: number | null
  wgst: number | null
  vis_m: number | null
  ceiling_ft: number | null
  temp_c: number | null
  dewpoint_c: number | null
  qnh_hpa: number | null
  flight_category: string
  raw: string
}

export interface TafPeriod {
  type: string   // 'BASE' | 'BECMG' | 'TEMPO' | 'FM' | 'PROB...'
  from: string | null
  to: string | null
  wdir: number | null
  wspd: number | null
  wgst: number | null
  vis_m: number | null
  ceiling_ft: number | null
}

export interface TafSnapshot {
  issue_time: string
  raw: string
  periods: TafPeriod[]
}

export interface WeatherTrendData {
  icao: string
  metar: MetarPoint[]
  taf_periods: TafPeriod[]
  taf_raw: string | null
  taf_history: TafSnapshot[]  // 과거 시점별로 실제 유효했던 TAF 이력 (BASE만 깔리는 일직선 방지용)
  error?: string
}

export interface WeatherHistoryTrend {
  icao: string
  count: number
  points: MetarPoint[]
  error?: string
}

export interface MonthlyStats {
  month: string          // 'YYYY-MM'
  count: number
  avg_wspd: number | null
  p10_wspd: number | null
  p90_wspd: number | null
  avg_vis_m: number | null
  p10_vis_m: number | null
  avg_ceiling_ft: number | null
  avg_temp_c: number | null
  avg_qnh_hpa: number | null
  cat_vfr: number
  cat_mvfr: number
  cat_ifr: number
  cat_lifr: number
}

export interface WeatherHistoryMonthly {
  icao: string
  months: MonthlyStats[]
  error?: string
}

// ─── FOIS 항로 제출 실적 이력 ────────────────────────────────────────────────

export interface FplCollectStatus {
  dep: string | null
  arr: string | null
  start: string
  end: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  total_days: number
  processed_days: number
  total_flights: number
  collected: number
  skipped: number
  failed: number
  error: string | null
}

export interface FplAircraftStat {
  ac_type: string
  count: number
  pct: number
  eet_avg_min: number | null
}

export interface FplRouteStat {
  route: string
  count: number
  pct: number
  distance_nm: number | null
  eet_avg_min: number | null  // 기종 무관, 이 항로 전체의 평균 비행시간(정렬용)
  last_flown: string          // 가장 최근 신고일(YYYY-MM-DD)
  // 이 항로를 실제로 탄 기종별 건수·평균 비행시간 — 항로가 짧아서 빠른 건지
  // 기종이 빨라서 빠른 건지 구분하려면 전체 평균이 아니라 이 단위로 봐야 함
  aircraft: FplAircraftStat[]
}

export interface FplAirlineBreakdown {
  airline: string
  count: number
  aircraft: FplAircraftStat[]
}

// 항로 실적 페이지에서 "이 제출 항로를 지도에 표시" 눌렀을 때 오버레이 —
// 특정 편 하나(FoisOverlayRoute)가 아니라 여러 편이 공유하는 항로 패턴이라
// ams_rec_pk가 아닌 항로 문자열 자체를 키로 씀
export interface FiledRouteOverlay {
  id: string
  dep: string
  arr: string
  route: string
  count: number
  coordinates: [number, number][]
  legs: { airway: string; coords: [number, number][] }[]
  waypoints: { id: string; lon: number; lat: number }[]
  color: string
}

export interface FplOdStats {
  dep: string
  arr: string
  count: number
  routes: FplRouteStat[]
  aircraft: FplAircraftStat[]
  by_airline: FplAirlineBreakdown[]
  eet_avg_min: number | null
  eet_min_min: number | null
  eet_max_min: number | null
}

export interface FplAirlineCount {
  code: string
  count: number
}

export interface FplHistoryStats {
  start: string
  end: string
  count: number
  groups: FplOdStats[]
  airlines: FplAirlineCount[]
  error?: string
}

// ─── 관리자: 근간 데이터(NAVDATA/항로 DB) 업로드 ─────────────────────────────

export interface AdminDataStatus {
  airports: number
  waypoints: number
  airways: number
  routes: number
  empty_routes: number
  suspicious_routes: number
  suspicious_sample: string[]
  minima_airports: number
  backups: string[]
}

export interface AdminUploadResult extends Omit<AdminDataStatus, 'minima_airports' | 'backups'> {
  ok: boolean
  target: 'navdata' | 'routes'
  backup: string | null
}

export interface AdminMinimaUploadResult {
  ok: boolean
  target: 'minima'
  backup: string | null
  resolved: number
  unresolved_iata: string[]
}

export interface CollectStatus {
  icao: string
  start: string
  end: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  total_months: number
  processed: number
  inserted: number
  skipped: number  // 이미 촘촘히 수집돼 있어 재수집을 건너뛴 달 수
  error: string | null
}

export type SpatialMode = 'polygon' | 'circle' | null

export interface SpatialFilter {
  type: 'polygon' | 'circle'
  /** turf-compatible closed polygon ring [[lon,lat],...,[lon,lat]] */
  ring: number[][]
  center?: [number, number]
  radiusNm?: number
}

export interface Typhoon {
  id: string
  name: string
  lat: number
  lon: number
  alert: 'Green' | 'Orange' | 'Red'
  wind_kt: number | null
  radius_nm: number
  color: string
}

export interface TyphoonTrackPoint extends Typhoon {
  step: number
  time: string
  is_forecast?: boolean
  pressure_hpa?: number | null
  // true면 /active의 실측 풍속·반경으로 덮어쓴 "현재 시점" 스텝 — 나머지는
  // GDACS 등급 라벨(TD/TS/HU) 기반 대표값이라 추정치임
  windIsExact?: boolean
}

export interface VolcanicAshStep {
  label: string  // 'OBS' | '+6HR' | '+12HR' | '+18HR'
  time: string | null
  polygon: [number, number][] | null  // [lon, lat][], null이면 이 구간엔 화산재 없음(NO VA EXP)
  fl_min: number | null
  fl_max: number | null
  status: 'ash' | 'no_ash' | 'unknown'
}

export interface VolcanicAshAdvisory {
  volcano: string
  area: string
  lat: number | null
  lon: number | null
  advisory_nr: string
  dtg: string
  vaac: string
  steps: VolcanicAshStep[]
  raw_text: string
}

export interface LayerState {
  routes: boolean        // navblue 저장 항로
  airports: boolean
  waypoints: boolean
  allAirways: boolean    // 전 세계 airway 배경 표시 (waypoints와 같은 성격)
  activeAirway: boolean  // 검색으로 찾은 airway 1개 강조 (navdata 기하, 점선)
  matchedRoutes: boolean // airway 검색으로 찾은 navblue 항로 (실선)
  typhoon: boolean
  volcanicAsh: boolean   // 화산재 구역 (Tokyo VAAC)
  fir: boolean
  curfew: boolean
  traffic: boolean
  weatherAlerts: boolean  // 초기 화면 우측 상단 기상 알람 토스트 표출 여부
}

export interface AppState {
  // Filters
  origin: string
  destination: string
  // Active search/selection
  selectedRouteIds: number[]
  hoveredRouteId: number | null  // 목록(우클릭 메뉴/사이드바)에서 마우스오버 중인 항로 — 지도에 노란색으로 강조
  activeAirway: string | null
  activeWaypoint: string | null
  // 공간 필터(태풍 등)와 교차하는 항로 id — 목록에서 정렬/강조용, allRoutes는 그대로 유지
  affectedRouteIds: number[]
  // Data
  allRoutes: RouteMeta[]
  routeGeoJSON: GeoJSONFeatureCollection | null
  airportsGeoJSON: GeoJSONFeatureCollection | null
  airwayGeoJSON: GeoJSONFeatureCollection | null
  matchedRoutesGeoJSON: GeoJSONFeatureCollection | null  // airway 검색 매칭 항로 geometry
  waypointsGeoJSON: GeoJSONFeatureCollection | null
  allAirwaysGeoJSON: GeoJSONFeatureCollection | null
  adhocRouteGeoJSON: GeoJSONFeatureCollection | null  // 직접 타이핑한 항로 문자열 (SkyVector 스타일) 결과
  // Layer visibility
  layers: LayerState
  // Spatial search
  spatialMode: SpatialMode
  spatialPoints: [number, number][]   // polygon vertices OR [circleCenter] while drawing
  spatialFilter: SpatialFilter | null
  // FIR
  firGeoJSON: GeoJSONFeatureCollection | null
  // Alternative route
  altRouteMode: boolean
  // Typhoon
  typhoons: Typhoon[]
  typhoonLoading: boolean
  typhoonTrack: TyphoonTrackPoint[] | null
  typhoonTrackStep: number
  // Volcanic ash
  volcanicAsh: VolcanicAshAdvisory[]
  volcanicAshLoading: boolean
  // UI
  searchResults: SearchResult[]
  isLoading: boolean
  // Multi-search highlights
  highlightPoints: SearchResult[]
  pendingFlyTo: { lon: number; lat: number; zoom?: number } | null
  pendingFitBounds: [[number, number], [number, number]] | null
  airwayEndpoints: Array<{ id: string; lon: number; lat: number }>
  // Traffic
  trafficData: AircraftState[]
  trafficLoading: boolean
  trafficLastUpdate: number | null
  // Curfew
  curfews: Record<string, CurfewInfo>
  curfewPanelOpen: boolean
  // Airport detail (static navdata)
  airportDetail: Record<string, AirportDetail>
  airportDetailLoading: boolean
  activeAirportTab: AirportTab
  // Weather
  weatherData: Record<string, MetarData>
  weatherAlerts: WeatherAlert[]
  weatherAlertTyphoonOnly: boolean  // true면 태풍 반경과 겹치는 공항의 알림만 표출
  weatherLoading: boolean
  selectedAirportIcao: string | null
  weatherConfig: WeatherConfig
  thresholdModalTarget: string | null  // null=닫힘, 'defaults'=전체기본값, ICAO=공항별
  // FOIS 실제 제출 항로 지도 오버레이 — ams_rec_pk로 키잉, 공항 패널 스케줄 탭에서 편별 토글
  foisOverlayRoutes: Record<number, FoisOverlayRoute>
  // 항로 실적 페이지에서 켠 "제출 항로 패턴" 지도 오버레이 — 항로 문자열로 키잉
  filedRouteOverlays: Record<string, FiledRouteOverlay>
}

export type AppAction =
  | { type: 'SET_ORIGIN'; payload: string }
  | { type: 'SET_DESTINATION'; payload: string }
  | { type: 'SET_SELECTED_ROUTES'; payload: number[] }
  | { type: 'TOGGLE_SELECTED_ROUTE'; payload: number }
  | { type: 'SET_HOVERED_ROUTE'; payload: number | null }
  | { type: 'SET_AFFECTED_ROUTES'; payload: number[] }
  | { type: 'SET_ACTIVE_AIRWAY'; payload: string | null }
  | { type: 'SET_ACTIVE_WAYPOINT'; payload: string | null }
  | { type: 'SET_ALL_ROUTES'; payload: RouteMeta[] }
  | { type: 'SET_ROUTE_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'SET_AIRPORTS_GEOJSON'; payload: GeoJSONFeatureCollection }
  | { type: 'SET_AIRWAY_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'SET_MATCHED_ROUTES_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'SET_WAYPOINTS_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'SET_ALL_AIRWAYS_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'SET_ADHOC_ROUTE_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'TOGGLE_LAYER'; payload: keyof LayerState }
  | { type: 'SET_SEARCH_RESULTS'; payload: SearchResult[] }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_SPATIAL_MODE'; payload: SpatialMode }
  | { type: 'ADD_SPATIAL_POINT'; payload: [number, number] }
  | { type: 'SET_SPATIAL_FILTER'; payload: SpatialFilter | null }
  | { type: 'CLEAR_SPATIAL' }
  | { type: 'SET_TYPHOONS'; payload: Typhoon[] }
  | { type: 'SET_TYPHOON_LOADING'; payload: boolean }
  | { type: 'SET_TYPHOON_TRACK'; payload: TyphoonTrackPoint[] | null }
  | { type: 'SET_TYPHOON_TRACK_STEP'; payload: number }
  | { type: 'SET_VOLCANIC_ASH'; payload: VolcanicAshAdvisory[] }
  | { type: 'SET_VOLCANIC_ASH_LOADING'; payload: boolean }
  | { type: 'SET_ALT_ROUTE_MODE'; payload: boolean }
  | { type: 'SET_FIR_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'ADD_HIGHLIGHT'; payload: SearchResult }
  | { type: 'REMOVE_HIGHLIGHT'; payload: string }
  | { type: 'CLEAR_HIGHLIGHTS' }
  | { type: 'SET_FLY_TO'; payload: { lon: number; lat: number; zoom?: number } | null }
  | { type: 'SET_FIT_BOUNDS'; payload: [[number, number], [number, number]] | null }
  | { type: 'ADD_AIRWAY_ENDPOINTS'; payload: Array<{ id: string; lon: number; lat: number }> }
  | { type: 'CLEAR_AIRWAY_ENDPOINTS' }
  | { type: 'MERGE_AIRWAY_GEOJSON'; payload: GeoJSONFeatureCollection }
  | { type: 'MERGE_MATCHED_ROUTES_GEOJSON'; payload: GeoJSONFeatureCollection }
  | { type: 'MERGE_ALL_ROUTES'; payload: RouteMeta[] }
  | { type: 'SET_TRAFFIC_DATA'; payload: { aircraft: AircraftState[]; updated: number } }
  | { type: 'SET_TRAFFIC_LOADING'; payload: boolean }
  | { type: 'SET_CURFEWS'; payload: CurfewInfo[] }
  | { type: 'TOGGLE_CURFEW_PANEL' }
  | { type: 'SET_AIRPORT_DETAIL'; payload: AirportDetail }
  | { type: 'SET_AIRPORT_DETAIL_LOADING'; payload: boolean }
  | { type: 'SET_AIRPORT_TAB'; payload: AirportTab }
  | { type: 'SET_WEATHER_DATA'; payload: MetarData[] }
  | { type: 'ADD_WEATHER_ALERTS'; payload: WeatherAlert[] }
  | { type: 'DISMISS_WEATHER_ALERT'; payload: string }
  | { type: 'SET_WEATHER_ALERT_TYPHOON_ONLY'; payload: boolean }
  | { type: 'SET_WEATHER_LOADING'; payload: boolean }
  | { type: 'SET_SELECTED_AIRPORT'; payload: string | null }
  | { type: 'SET_WEATHER_CONFIG'; payload: WeatherConfig }
  | { type: 'SET_AIRPORT_THRESHOLDS'; payload: { icao: string; thresholds: WeatherThresholds } }
  | { type: 'SET_DEFAULT_THRESHOLDS'; payload: WeatherThresholds }
  | { type: 'RESET_AIRPORT_THRESHOLDS'; payload: string }
  | { type: 'OPEN_THRESHOLD_MODAL'; payload: string }
  | { type: 'CLOSE_THRESHOLD_MODAL' }
  | { type: 'ADD_FOIS_OVERLAY_ROUTE'; payload: FoisOverlayRoute }
  | { type: 'REMOVE_FOIS_OVERLAY_ROUTE'; payload: number }
  | { type: 'CLEAR_FOIS_OVERLAY_ROUTES' }
  | { type: 'ADD_FILED_ROUTE_OVERLAY'; payload: FiledRouteOverlay }
  | { type: 'REMOVE_FILED_ROUTE_OVERLAY'; payload: string }
  | { type: 'CLEAR_FILED_ROUTE_OVERLAYS' }
