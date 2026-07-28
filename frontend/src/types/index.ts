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
}

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJSONFeature[]
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
  type: 'airport' | 'airway' | 'waypoint' | 'route'
  id: string
  name: string
  lat: number | null
  lon: number | null
  description: string
  route?: RouteMeta  // type === 'route'일 때만 채워짐
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

export type AirportTab = 'weather' | 'runway' | 'approach'

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

export interface WeatherTrendData {
  icao: string
  metar: MetarPoint[]
  taf_periods: TafPeriod[]
  taf_raw: string | null
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

export interface CollectStatus {
  icao: string
  start: string
  end: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  total_months: number
  processed: number
  inserted: number
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
}

export interface LayerState {
  routes: boolean        // navblue 저장 항로
  airports: boolean
  waypoints: boolean
  allAirways: boolean    // 전 세계 airway 배경 표시 (waypoints와 같은 성격)
  activeAirway: boolean  // 검색으로 찾은 airway 1개 강조 (navdata 기하, 점선)
  matchedRoutes: boolean // airway 검색으로 찾은 navblue 항로 (실선)
  typhoon: boolean
  fir: boolean
  curfew: boolean
  traffic: boolean
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
  weatherLoading: boolean
  selectedAirportIcao: string | null
  weatherConfig: WeatherConfig
  thresholdModalTarget: string | null  // null=닫힘, 'defaults'=전체기본값, ICAO=공항별
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
  | { type: 'SET_WEATHER_LOADING'; payload: boolean }
  | { type: 'SET_SELECTED_AIRPORT'; payload: string | null }
  | { type: 'SET_WEATHER_CONFIG'; payload: WeatherConfig }
  | { type: 'SET_AIRPORT_THRESHOLDS'; payload: { icao: string; thresholds: WeatherThresholds } }
  | { type: 'SET_DEFAULT_THRESHOLDS'; payload: WeatherThresholds }
  | { type: 'RESET_AIRPORT_THRESHOLDS'; payload: string }
  | { type: 'OPEN_THRESHOLD_MODAL'; payload: string }
  | { type: 'CLOSE_THRESHOLD_MODAL' }
