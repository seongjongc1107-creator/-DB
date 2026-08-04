import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react'
import type { AppState, AppAction, LayerState } from './types'
import { loadConfig, saveConfig } from './lib/weatherClassify'

const initialState: AppState = {
  origin: '',
  destination: '',
  selectedRouteIds: [],
  hoveredRouteId: null,
  affectedRouteIds: [],
  activeAirway: null,
  activeWaypoint: null,
  allRoutes: [],
  routeGeoJSON: null,
  airportsGeoJSON: null,
  airwayGeoJSON: null,
  matchedRoutesGeoJSON: null,
  waypointsGeoJSON: null,
  allAirwaysGeoJSON: null,
  adhocRouteGeoJSON: null,
  layers: {
    routes: true,
    airports: true,
    waypoints: false,
    allAirways: false,
    activeAirway: false,
    matchedRoutes: true,
    typhoon: true,
    volcanicAsh: false,
    fir: false,
    curfew: true,
    traffic: false,
    weatherAlerts: false,
  },
  spatialMode: null,
  spatialPoints: [],
  spatialFilter: null,
  firGeoJSON: null,
  altRouteMode: false,
  typhoons: [],
  typhoonLoading: false,
  typhoonTrack: null,
  typhoonTrackStep: 0,
  volcanicAsh: [],
  volcanicAshLoading: false,
  searchResults: [],
  isLoading: false,
  highlightPoints: [],
  pendingFlyTo: null,
  pendingFitBounds: null,
  airwayEndpoints: [],
  trafficData: [],
  trafficLoading: false,
  trafficLastUpdate: null,
  curfews: {},
  curfewPanelOpen: false,
  airportDetail: {},
  airportDetailLoading: false,
  activeAirportTab: 'weather',
  weatherData: {},
  weatherAlerts: [],
  weatherAlertTyphoonOnly: false,
  weatherLoading: false,
  selectedAirportIcao: null,
  weatherConfig: loadConfig(),
  thresholdModalTarget: null,
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_ORIGIN':
      return { ...state, origin: action.payload }
    case 'SET_DESTINATION':
      return { ...state, destination: action.payload }
    case 'SET_SELECTED_ROUTES':
      return { ...state, selectedRouteIds: action.payload }
    case 'TOGGLE_SELECTED_ROUTE': {
      // 최대 10개까지 선택 가능(지도에서 동시에 보기용). 상세 비교 패널은 정확히
      // 2개일 때만 의미가 있음(RouteComparePanel에서 별도 처리).
      // 이미 선택된 걸 누르면 해제, 11번째를 고르면 가장 먼저 고른 걸 밀어냄.
      const MAX_SELECTED = 10
      const current = state.selectedRouteIds
      const id = action.payload
      let next: number[]
      if (current.includes(id)) next = current.filter(x => x !== id)
      else if (current.length >= MAX_SELECTED) next = [...current.slice(1), id]
      else next = [...current, id]
      return { ...state, selectedRouteIds: next }
    }
    case 'SET_HOVERED_ROUTE':
      return { ...state, hoveredRouteId: action.payload }
    case 'SET_AFFECTED_ROUTES':
      return { ...state, affectedRouteIds: action.payload }
    case 'SET_ACTIVE_AIRWAY':
      return {
        ...state,
        activeAirway: action.payload,
        layers: {
          ...state.layers,
          activeAirway: action.payload !== null,
          matchedRoutes: action.payload !== null ? true : state.layers.matchedRoutes,
        },
      }
    case 'SET_ALL_ROUTES':
      return { ...state, allRoutes: action.payload }
    case 'SET_ROUTE_GEOJSON':
      return { ...state, routeGeoJSON: action.payload }
    case 'SET_AIRPORTS_GEOJSON':
      return { ...state, airportsGeoJSON: action.payload }
    case 'SET_ACTIVE_WAYPOINT':
      return {
        ...state,
        activeWaypoint: action.payload,
        layers: {
          ...state.layers,
          matchedRoutes: action.payload !== null ? true : state.layers.matchedRoutes,
        },
      }
    case 'SET_AIRWAY_GEOJSON':
      return { ...state, airwayGeoJSON: action.payload }
    case 'SET_MATCHED_ROUTES_GEOJSON':
      return { ...state, matchedRoutesGeoJSON: action.payload }
    case 'SET_WAYPOINTS_GEOJSON':
      return { ...state, waypointsGeoJSON: action.payload }
    case 'SET_ALL_AIRWAYS_GEOJSON':
      return { ...state, allAirwaysGeoJSON: action.payload }
    case 'SET_ADHOC_ROUTE_GEOJSON':
      return { ...state, adhocRouteGeoJSON: action.payload }
    case 'TOGGLE_LAYER':
      return {
        ...state,
        layers: {
          ...state.layers,
          [action.payload]: !state.layers[action.payload as keyof LayerState],
        },
      }
    case 'SET_SEARCH_RESULTS':
      return { ...state, searchResults: action.payload }
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload }
    case 'SET_SPATIAL_MODE':
      return { ...state, spatialMode: action.payload, spatialPoints: [] }
    case 'ADD_SPATIAL_POINT':
      return { ...state, spatialPoints: [...state.spatialPoints, action.payload] }
    case 'SET_SPATIAL_FILTER':
      return { ...state, spatialFilter: action.payload, spatialMode: null, spatialPoints: [] }
    case 'CLEAR_SPATIAL':
      return { ...state, spatialMode: null, spatialPoints: [], spatialFilter: null }
    case 'SET_TYPHOONS':
      return { ...state, typhoons: action.payload }
    case 'SET_TYPHOON_LOADING':
      return { ...state, typhoonLoading: action.payload }
    case 'SET_TYPHOON_TRACK': {
      const track = action.payload
      // 트랙 로드 시 맨 처음(수일 전 과거)이 아니라 "현재 시점"부터 보여줌 —
      // is_forecast가 처음으로 true가 되는 지점 바로 앞(=가장 최근 실측)을 현재로 봄.
      // 전부 과거 실측이면(태풍이 이미 소멸) 마지막 스텝을, 전부 예보면 0을 사용.
      let startStep = 0
      if (track && track.length > 0) {
        const firstForecastIdx = track.findIndex(p => p.is_forecast)
        startStep = firstForecastIdx === -1
          ? track.length - 1
          : Math.max(0, firstForecastIdx - 1)
      }
      return { ...state, typhoonTrack: track, typhoonTrackStep: startStep }
    }
    case 'SET_TYPHOON_TRACK_STEP':
      return { ...state, typhoonTrackStep: action.payload }
    case 'SET_VOLCANIC_ASH':
      return { ...state, volcanicAsh: action.payload }
    case 'SET_VOLCANIC_ASH_LOADING':
      return { ...state, volcanicAshLoading: action.payload }
    case 'SET_FIR_GEOJSON':
      return { ...state, firGeoJSON: action.payload }
    case 'SET_ALT_ROUTE_MODE':
      return { ...state, altRouteMode: action.payload }
    case 'ADD_HIGHLIGHT': {
      // id가 같아도 위치가 다른 경우가 있어서(예: PIANO가 미국·대만에 둘 다 있음)
      // 좌표까지 같이 봐야 서로 다른 검색 결과로 구분됨 — 안 그러면 두 번째 걸
      // 고를 때 첫 번째가 조용히 밀려남
      const isSame = (p: typeof action.payload) =>
        p.id === action.payload.id && p.lat === action.payload.lat && p.lon === action.payload.lon
      return {
        ...state,
        highlightPoints: [
          ...state.highlightPoints.filter(p => !isSame(p)),
          action.payload,
        ],
      }
    }
    case 'REMOVE_HIGHLIGHT':
      return { ...state, highlightPoints: state.highlightPoints.filter(p => p.id !== action.payload) }
    case 'CLEAR_HIGHLIGHTS':
      return { ...state, highlightPoints: [], pendingFlyTo: null }
    case 'SET_FLY_TO':
      return { ...state, pendingFlyTo: action.payload }
    case 'SET_FIT_BOUNDS':
      return { ...state, pendingFitBounds: action.payload }
    case 'ADD_AIRWAY_ENDPOINTS':
      return { ...state, airwayEndpoints: [...state.airwayEndpoints, ...action.payload] }
    case 'CLEAR_AIRWAY_ENDPOINTS':
      return { ...state, airwayEndpoints: [] }
    case 'MERGE_AIRWAY_GEOJSON': {
      const existing = state.airwayGeoJSON?.features ?? []
      return {
        ...state,
        airwayGeoJSON: {
          type: 'FeatureCollection',
          features: [...existing, ...action.payload.features],
        },
      }
    }
    case 'MERGE_MATCHED_ROUTES_GEOJSON': {
      const existingIds = new Set(state.matchedRoutesGeoJSON?.features.map(f => f.properties?.id))
      const newFeatures = action.payload.features.filter(f => !existingIds.has(f.properties?.id))
      return {
        ...state,
        matchedRoutesGeoJSON: {
          type: 'FeatureCollection',
          features: [...(state.matchedRoutesGeoJSON?.features ?? []), ...newFeatures],
        },
      }
    }
    case 'MERGE_ALL_ROUTES': {
      const existingIds = new Set(state.allRoutes.map(r => r.id))
      const newRoutes = action.payload.filter(r => !existingIds.has(r.id))
      return { ...state, allRoutes: [...state.allRoutes, ...newRoutes] }
    }
    case 'SET_WEATHER_DATA': {
      // 응답 배열엔 공항당 최근 몇 시간치 관측이 섞여서 옴(시간순 보장 안 됨) —
      // 관측시각(obs_time)이 기존에 저장된 것보다 최신일 때만 덮어써서, 배열
      // 안에서 더 오래된 항목이 뒤에 나온다는 이유로 최신 관측을 밀어내는 걸 방지.
      const updated = { ...state.weatherData }
      for (const d of action.payload) {
        const prev = updated[d.icao]
        if (!prev || !prev.obs_time || !d.obs_time || d.obs_time >= prev.obs_time) {
          updated[d.icao] = d
        }
      }
      return { ...state, weatherData: updated }
    }
    case 'ADD_WEATHER_ALERTS':
      return { ...state, weatherAlerts: [...action.payload, ...state.weatherAlerts].slice(0, 20) }
    case 'DISMISS_WEATHER_ALERT':
      return { ...state, weatherAlerts: state.weatherAlerts.filter(a => a.id !== action.payload) }
    case 'SET_WEATHER_ALERT_TYPHOON_ONLY':
      return { ...state, weatherAlertTyphoonOnly: action.payload }
    case 'SET_WEATHER_LOADING':
      return { ...state, weatherLoading: action.payload }
    case 'SET_TRAFFIC_DATA':
      return { ...state, trafficData: action.payload.aircraft, trafficLastUpdate: action.payload.updated }
    case 'SET_TRAFFIC_LOADING':
      return { ...state, trafficLoading: action.payload }
    case 'SET_CURFEWS': {
      const map: Record<string, import('./types').CurfewInfo> = {}
      for (const c of action.payload) map[c.icao] = c
      return { ...state, curfews: map }
    }
    case 'TOGGLE_CURFEW_PANEL':
      return { ...state, curfewPanelOpen: !state.curfewPanelOpen }
    case 'SET_AIRPORT_DETAIL': {
      return { ...state, airportDetail: { ...state.airportDetail, [action.payload.icao]: action.payload } }
    }
    case 'SET_AIRPORT_DETAIL_LOADING':
      return { ...state, airportDetailLoading: action.payload }
    case 'SET_AIRPORT_TAB':
      return { ...state, activeAirportTab: action.payload }
    case 'SET_SELECTED_AIRPORT':
      return { ...state, selectedAirportIcao: action.payload, activeAirportTab: 'weather' }
    case 'SET_WEATHER_CONFIG':
      saveConfig(action.payload)
      return { ...state, weatherConfig: action.payload }
    case 'SET_DEFAULT_THRESHOLDS': {
      const next = { ...state.weatherConfig, defaults: action.payload }
      saveConfig(next)
      return { ...state, weatherConfig: next }
    }
    case 'SET_AIRPORT_THRESHOLDS': {
      const next = {
        ...state.weatherConfig,
        airports: { ...state.weatherConfig.airports, [action.payload.icao]: action.payload.thresholds },
      }
      saveConfig(next)
      return { ...state, weatherConfig: next }
    }
    case 'RESET_AIRPORT_THRESHOLDS': {
      const airports = { ...state.weatherConfig.airports }
      delete airports[action.payload]
      const next = { ...state.weatherConfig, airports }
      saveConfig(next)
      return { ...state, weatherConfig: next }
    }
    case 'OPEN_THRESHOLD_MODAL':
      return { ...state, thresholdModalTarget: action.payload }
    case 'CLOSE_THRESHOLD_MODAL':
      return { ...state, thresholdModalTarget: null }
    default:
      return state
  }
}

const AppContext = createContext<{ state: AppState; dispatch: Dispatch<AppAction> } | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be inside AppProvider')
  return ctx
}
