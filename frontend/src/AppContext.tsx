import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react'
import type { AppState, AppAction, LayerState } from './types'

const initialState: AppState = {
  origin: '',
  destination: '',
  selectedRouteIds: [],
  activeAirway: null,
  activeWaypoint: null,
  allRoutes: [],
  routeGeoJSON: null,
  airportsGeoJSON: null,
  airwayGeoJSON: null,
  matchedRoutesGeoJSON: null,
  waypointsGeoJSON: null,
  layers: {
    routes: true,
    airports: true,
    waypoints: false,
    activeAirway: false,
    matchedRoutes: true,
    typhoon: true,
    fir: true,
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
  searchResults: [],
  isLoading: false,
  highlightPoints: [],
  pendingFlyTo: null,
  pendingFitBounds: null,
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_ORIGIN':
      return { ...state, origin: action.payload }
    case 'SET_DESTINATION':
      return { ...state, destination: action.payload }
    case 'SET_SELECTED_ROUTES':
      return { ...state, selectedRouteIds: action.payload }
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
    case 'SET_TYPHOON_TRACK':
      return { ...state, typhoonTrack: action.payload, typhoonTrackStep: 0 }
    case 'SET_TYPHOON_TRACK_STEP':
      return { ...state, typhoonTrackStep: action.payload }
    case 'SET_FIR_GEOJSON':
      return { ...state, firGeoJSON: action.payload }
    case 'SET_ALT_ROUTE_MODE':
      return { ...state, altRouteMode: action.payload }
    case 'ADD_HIGHLIGHT':
      return {
        ...state,
        highlightPoints: [
          ...state.highlightPoints.filter(p => p.id !== action.payload.id),
          action.payload,
        ],
      }
    case 'REMOVE_HIGHLIGHT':
      return { ...state, highlightPoints: state.highlightPoints.filter(p => p.id !== action.payload) }
    case 'CLEAR_HIGHLIGHTS':
      return { ...state, highlightPoints: [], pendingFlyTo: null }
    case 'SET_FLY_TO':
      return { ...state, pendingFlyTo: action.payload }
    case 'SET_FIT_BOUNDS':
      return { ...state, pendingFitBounds: action.payload }
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
