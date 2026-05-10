import type { GeoJSONFeatureCollection, RouteMeta, SearchResult, Typhoon, TyphoonTrackPoint } from '../types'

const BASE = '/api'

async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(BASE + path, window.location.origin)
  if (params) {
    Object.entries(params).forEach(([k, v]) => v && url.searchParams.set(k, v))
  }
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`)
  return res.json()
}

export const api = {
  routes: {
    list(params?: { origin?: string; destination?: string; fix?: string }) {
      return get<{ count: number; routes: RouteMeta[] }>('/routes', params as Record<string, string>)
    },
    geometry(params?: { origin?: string; destination?: string; fix?: string; ids?: string }) {
      return get<GeoJSONFeatureCollection>('/routes/geometry', params as Record<string, string>)
    },
    origins: () => get<string[]>('/routes/origins'),
    destinations: () => get<string[]>('/routes/destinations'),
    alternatives: (odPairs: string, excludeIds: string) =>
      get<GeoJSONFeatureCollection>('/routes/alternatives', { od_pairs: odPairs, exclude_ids: excludeIds }),
  },
  navdata: {
    fir: () => get<GeoJSONFeatureCollection>('/navdata/fir'),
    airports: () => get<GeoJSONFeatureCollection>('/navdata/airports'),
    airway: (name: string) => get<GeoJSONFeatureCollection>(`/navdata/airways/${encodeURIComponent(name)}`),
    airwayRoutes: (name: string) =>
      get<{ count: number; routes: RouteMeta[] }>(`/navdata/airways/${encodeURIComponent(name)}/routes`),
    waypoints: (bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }) =>
      get<GeoJSONFeatureCollection>('/navdata/waypoints', bbox ? {
        minLat: String(bbox.minLat), maxLat: String(bbox.maxLat),
        minLon: String(bbox.minLon), maxLon: String(bbox.maxLon),
      } : undefined),
  },
  search: (q: string) => get<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`),
  typhoon: {
    active: () => get<{ source: string; count: number; typhoons: Typhoon[]; error?: string }>('/typhoon/active'),
    mock: () => get<{ name: string; count: number; track: TyphoonTrackPoint[] }>('/typhoon/mock'),
    track: (eventId: string) => get<{ name: string; count: number; track: TyphoonTrackPoint[]; error?: string }>(`/typhoon/track/${eventId}`),
  },
}
