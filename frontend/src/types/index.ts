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
  type: 'airport' | 'airway' | 'waypoint'
  id: string
  name: string
  lat: number | null
  lon: number | null
  description: string
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
}

export interface LayerState {
  routes: boolean        // navblue 저장 항로
  airports: boolean
  waypoints: boolean
  activeAirway: boolean  // airway 자체 경로 (navdata 기하, 점선)
  matchedRoutes: boolean // airway 검색으로 찾은 navblue 항로 (실선)
  typhoon: boolean
  fir: boolean
}

export interface AppState {
  // Filters
  origin: string
  destination: string
  // Active search/selection
  selectedRouteIds: number[]
  activeAirway: string | null
  activeWaypoint: string | null
  // Data
  allRoutes: RouteMeta[]
  routeGeoJSON: GeoJSONFeatureCollection | null
  airportsGeoJSON: GeoJSONFeatureCollection | null
  airwayGeoJSON: GeoJSONFeatureCollection | null
  matchedRoutesGeoJSON: GeoJSONFeatureCollection | null  // airway 검색 매칭 항로 geometry
  waypointsGeoJSON: GeoJSONFeatureCollection | null
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
}

export type AppAction =
  | { type: 'SET_ORIGIN'; payload: string }
  | { type: 'SET_DESTINATION'; payload: string }
  | { type: 'SET_SELECTED_ROUTES'; payload: number[] }
  | { type: 'SET_ACTIVE_AIRWAY'; payload: string | null }
  | { type: 'SET_ACTIVE_WAYPOINT'; payload: string | null }
  | { type: 'SET_ALL_ROUTES'; payload: RouteMeta[] }
  | { type: 'SET_ROUTE_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'SET_AIRPORTS_GEOJSON'; payload: GeoJSONFeatureCollection }
  | { type: 'SET_AIRWAY_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'SET_MATCHED_ROUTES_GEOJSON'; payload: GeoJSONFeatureCollection | null }
  | { type: 'SET_WAYPOINTS_GEOJSON'; payload: GeoJSONFeatureCollection | null }
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
  | { type: 'MERGE_AIRWAY_GEOJSON'; payload: GeoJSONFeatureCollection }
  | { type: 'MERGE_MATCHED_ROUTES_GEOJSON'; payload: GeoJSONFeatureCollection }
  | { type: 'MERGE_ALL_ROUTES'; payload: RouteMeta[] }
