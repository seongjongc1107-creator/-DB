import type { AircraftState, AirportDetail, CollectStatus, CurfewInfo, GeoJSONFeatureCollection, MetarData, RouteMeta, SearchResult, Typhoon, TyphoonTrackPoint, VolcanicAshAdvisory, WeatherHistoryMonthly, WeatherHistoryTrend, WeatherTrendData } from '../types'

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
    parse: (route: string) =>
      get<GeoJSONFeatureCollection & { unresolved: string[]; airway_gaps: string[] }>('/routes/parse', { route }),
  },
  navdata: {
    fir: () => get<GeoJSONFeatureCollection>('/navdata/fir'),
    airports: () => get<GeoJSONFeatureCollection>('/navdata/airports'),
    airportDetail: (icao: string) => get<AirportDetail>(`/navdata/airport/${encodeURIComponent(icao)}`),
    airway: (name: string) => get<GeoJSONFeatureCollection>(`/navdata/airways/${encodeURIComponent(name)}`),
    allAirways: () => get<GeoJSONFeatureCollection>('/navdata/airways'),
    airwayRoutes: (name: string) =>
      get<{ count: number; routes: RouteMeta[] }>(`/navdata/airways/${encodeURIComponent(name)}/routes`),
    waypoints: (limit = 50000) =>
      get<GeoJSONFeatureCollection>('/navdata/waypoints', { limit: String(limit) }),
  },
  traffic: {
    fetch: () => get<{ aircraft: AircraftState[]; count: number; jja_count: number; updated: number; error?: string; cached?: boolean }>('/traffic/'),
  },
  curfew: {
    list: () => get<{ count: number; curfews: CurfewInfo[] }>('/curfew/'),
    upload: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      return fetch(`${BASE}/curfew/upload`, { method: 'POST', body: form })
        .then(r => { if (!r.ok) throw new Error(`Upload failed ${r.status}`); return r.json() as Promise<{ count: number; curfews: CurfewInfo[] }> })
    },
    clear: () => fetch(`${BASE}/curfew/`, { method: 'DELETE' }).then(r => r.json()),
  },
  search: (q: string) => get<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`),
  typhoon: {
    active: () => get<{ source: string; count: number; typhoons: Typhoon[]; error?: string }>('/typhoon/active'),
    mock: () => get<{ name: string; count: number; track: TyphoonTrackPoint[] }>('/typhoon/mock'),
    track: (eventId: string) => get<{ name: string; count: number; track: TyphoonTrackPoint[]; error?: string }>(`/typhoon/track/${eventId}`),
  },
  volcanicAsh: {
    active: () => get<{ source: string; count: number; advisories: VolcanicAshAdvisory[]; error?: string }>('/volcanic-ash/active'),
  },
  weather: {
    bulk: (icaos: string[]) =>
      get<{ data: MetarData[]; error?: string }>('/weather/metar', { icaos: icaos.join(',') }),
    trend: (icao: string, hours = 24) =>
      get<WeatherTrendData>('/weather/metar/trend', { icao, hours: String(hours) }),
    historyCollect: (icao: string, start: string, end: string) => {
      const url = new URL(BASE + '/weather/history/collect', window.location.origin)
      url.searchParams.set('icao', icao)
      url.searchParams.set('start', start)
      url.searchParams.set('end', end)
      return fetch(url.toString(), { method: 'POST' }).then(r => r.json() as Promise<{ task_id: string; error?: string }>)
    },
    historyStatus: (taskId: string) =>
      get<CollectStatus>(`/weather/history/status/${encodeURIComponent(taskId)}`),
    historyTrend: (icao: string, start: string, end: string) =>
      get<WeatherHistoryTrend>('/weather/history/trend', { icao, start, end }),
    historyMonthly: (icao: string, start: string, end: string) =>
      get<WeatherHistoryMonthly>('/weather/history/monthly', { icao, start, end }),
  },
}
