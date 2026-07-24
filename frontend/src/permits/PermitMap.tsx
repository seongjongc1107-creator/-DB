import { useEffect, useRef, useState } from 'react'
import Map, { Source, Layer, Marker, type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { DummyFlight, RouteOption, CountryPermit } from './types'
import { COUNTRY_POLYGONS } from './dummyData'

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

const STATUS_COLORS = {
  valid:    '#10B981',
  expiring: '#F59E0B',
  not_held: '#EF4444',
} as const

function getRouteHealth(route: RouteOption): 'clear' | 'warning' | 'blocked' {
  if (route.permits.some(p => p.status === 'not_held')) return 'blocked'
  if (route.permits.some(p => p.status === 'expiring')) return 'warning'
  return 'clear'
}

const ROUTE_HEALTH_COLORS: Record<string, string> = {
  clear:   '#059669',
  warning: '#D97706',
  blocked: '#DC2626',
}

interface Props {
  flight: DummyFlight | null
  selectedRouteIdx: number
  highlightedCountry: string | null
  onHighlightCountry: (code: string | null) => void
  onOpenApp: (country: CountryPermit) => void
}

export default function PermitMap({ flight, selectedRouteIdx, highlightedCountry, onHighlightCountry, onOpenApp }: Props) {
  const mapRef = useRef<MapRef>(null)
  const [mapLoaded, setMapLoaded] = useState(false)

  const selectedRoute = flight?.routes[selectedRouteIdx] ?? null

  // Auto fit-bounds to selected route
  useEffect(() => {
    if (!mapLoaded || !selectedRoute || !mapRef.current) return
    const coords = selectedRoute.routeCoords
    const lons = coords.map(c => c[0])
    const lats = coords.map(c => c[1])
    mapRef.current.fitBounds(
      [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      { padding: 40, duration: 800 },
    )
  }, [mapLoaded, flight, selectedRouteIdx])

  // Country overlay GeoJSON (selected route only)
  const countryOverlayData = selectedRoute ? (() => {
    const features = selectedRoute.permits
      .filter(p => COUNTRY_POLYGONS[p.countryCode])
      .map(p => ({
        type: 'Feature' as const,
        properties: { code: p.countryCode, status: p.status },
        geometry: { type: 'Polygon' as const, coordinates: COUNTRY_POLYGONS[p.countryCode].coords },
      }))
    return { type: 'FeatureCollection' as const, features }
  })() : { type: 'FeatureCollection' as const, features: [] }

  // All routes GeoJSON (for drawing all route lines)
  const allRoutesData = flight ? {
    type: 'FeatureCollection' as const,
    features: flight.routes.map((route, idx) => ({
      type: 'Feature' as const,
      properties: {
        routeIdx: idx,
        health: getRouteHealth(route),
        selected: idx === selectedRouteIdx,
      },
      geometry: { type: 'LineString' as const, coordinates: route.routeCoords },
    })),
  } : { type: 'FeatureCollection' as const, features: [] }

  return (
    <div className="w-full h-full relative">
      <Map
        ref={mapRef}
        mapStyle={MAP_STYLE}
        initialViewState={{ longitude: 80, latitude: 40, zoom: 3 }}
        style={{ width: '100%', height: '100%' }}
        onLoad={() => setMapLoaded(true)}
      >
        {/* Country overlay — fill by permit status (selected route only) */}
        <Source id="country-overlay" type="geojson" data={countryOverlayData}>
          <Layer
            id="country-fill"
            type="fill"
            paint={{
              'fill-color': [
                'match', ['get', 'status'],
                'valid',    '#10B981',
                'expiring', '#F59E0B',
                'not_held', '#EF4444',
                '#6B7280',
              ],
              'fill-opacity': [
                'case',
                ['==', ['get', 'code'], highlightedCountry ?? ''], 0.25,
                0.10,
              ],
            }}
          />
          <Layer
            id="country-line"
            type="line"
            paint={{
              'line-color': [
                'match', ['get', 'status'],
                'valid',    '#10B981',
                'expiring', '#F59E0B',
                'not_held', '#EF4444',
                '#6B7280',
              ],
              'line-width': [
                'case',
                ['==', ['get', 'code'], highlightedCountry ?? ''], 2.5,
                1.5,
              ],
              'line-opacity': 0.7,
            }}
          />
        </Source>

        {/* All routes — non-selected as thin dashed lines */}
        <Source id="all-routes" type="geojson" data={allRoutesData}>
          <Layer
            id="unselected-routes"
            type="line"
            filter={['==', ['get', 'selected'], false]}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{
              'line-color': [
                'match', ['get', 'health'],
                'clear',   ROUTE_HEALTH_COLORS.clear,
                'warning', ROUTE_HEALTH_COLORS.warning,
                'blocked', ROUTE_HEALTH_COLORS.blocked,
                '#6B7280',
              ],
              'line-width': 1.5,
              'line-opacity': 0.35,
              'line-dasharray': [4, 3],
            }}
          />
          {/* Selected route casing */}
          <Layer
            id="selected-route-casing"
            type="line"
            filter={['==', ['get', 'selected'], true]}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.25 }}
          />
          {/* Selected route line */}
          <Layer
            id="selected-route-line"
            type="line"
            filter={['==', ['get', 'selected'], true]}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#38BDF8', 'line-width': 3, 'line-opacity': 1 }}
          />
        </Source>

        {/* Origin / Destination markers */}
        {flight && selectedRoute && (
          <>
            <Marker longitude={selectedRoute.routeCoords[0][0]} latitude={selectedRoute.routeCoords[0][1]} anchor="center">
              <div className="flex flex-col items-center pointer-events-none">
                <div className="w-4 h-4 rounded-full bg-sky-400 border-2 border-white shadow-lg" />
                <span className="mt-1 text-[10px] font-bold text-sky-300 bg-gray-900/80 px-1 rounded whitespace-nowrap">
                  {flight.info.origin}
                </span>
              </div>
            </Marker>
            <Marker
              longitude={selectedRoute.routeCoords[selectedRoute.routeCoords.length - 1][0]}
              latitude={selectedRoute.routeCoords[selectedRoute.routeCoords.length - 1][1]}
              anchor="center"
            >
              <div className="flex flex-col items-center pointer-events-none">
                <div className="w-4 h-4 rounded-full bg-sky-400 border-2 border-white shadow-lg" />
                <span className="mt-1 text-[10px] font-bold text-sky-300 bg-gray-900/80 px-1 rounded whitespace-nowrap">
                  {flight.info.destination}
                </span>
              </div>
            </Marker>
          </>
        )}

        {/* Country crossing markers (selected route only) */}
        {selectedRoute && selectedRoute.permits.map(permit => {
          const color = STATUS_COLORS[permit.status]
          const isHighlighted = highlightedCountry === permit.countryCode
          return (
            <Marker
              key={permit.countryCode}
              longitude={permit.entryCoord[0]}
              latitude={permit.entryCoord[1]}
              anchor="center"
            >
              <div
                className="relative flex flex-col items-center cursor-pointer"
                onMouseEnter={() => onHighlightCountry(permit.countryCode)}
                onMouseLeave={() => onHighlightCountry(null)}
                onClick={() => (permit.status === 'not_held' || permit.status === 'expiring') && onOpenApp(permit)}
              >
                {permit.status === 'not_held' && (
                  <div
                    className="absolute w-8 h-8 rounded-full animate-ping opacity-50"
                    style={{ backgroundColor: color }}
                  />
                )}
                <div
                  className="relative w-6 h-6 rounded-full border-2 border-white shadow-xl flex items-center justify-center text-[10px] font-bold text-white transition-transform"
                  style={{
                    backgroundColor: color,
                    transform: isHighlighted ? 'scale(1.4)' : 'scale(1)',
                    zIndex: isHighlighted ? 10 : 1,
                  }}
                >
                  {permit.countryCode.slice(0, 2)}
                </div>
                {isHighlighted && (
                  <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-gray-900/95 border border-gray-600 text-xs rounded-lg shadow-2xl p-2 whitespace-nowrap z-20 pointer-events-none">
                    <div className="font-semibold text-white">{permit.flag} {permit.countryName}</div>
                    <div className="mt-0.5" style={{ color }}>
                      {permit.status === 'valid' ? '✅ 유효' : permit.status === 'expiring' ? '⚠️ 만료임박' : '❌ 미보유'}
                      {permit.validTo && ` ~${permit.validTo}`}
                    </div>
                    {(permit.status === 'not_held' || permit.status === 'expiring') && (
                      <div className="text-gray-400 mt-1">클릭하여 신청서 작성</div>
                    )}
                  </div>
                )}
              </div>
            </Marker>
          )
        })}
      </Map>

      {/* Empty state */}
      {!flight && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-gray-900/80 border border-gray-700 rounded-xl px-6 py-4 text-center">
            <div className="text-gray-400 text-sm">편명을 입력하고 조회하세요</div>
            <div className="text-gray-600 text-xs mt-1">예) KE901, KE085, KE017, OZ201</div>
          </div>
        </div>
      )}

      {/* Route indicator (top center) */}
      {flight && selectedRoute && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-gray-900/90 border border-gray-700 rounded-full px-3 py-1.5 text-xs pointer-events-none">
          <span className="text-sky-400 font-bold">Route {selectedRoute.routeNumber}</span>
          <span className="text-gray-400">{selectedRoute.routeName}</span>
          <span className="text-gray-600">·</span>
          <span className="text-gray-400">{selectedRoute.distance.toLocaleString()} NM</span>
        </div>
      )}

      {/* Legend */}
      {flight && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-gray-900/90 border border-gray-700 rounded-full px-4 py-2 text-xs pointer-events-none">
          <span className="flex items-center gap-1.5 text-emerald-400">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" /> 유효
          </span>
          <span className="flex items-center gap-1.5 text-amber-400">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> 만료임박
          </span>
          <span className="flex items-center gap-1.5 text-red-400">
            <span className="w-2.5 h-2.5 rounded-full bg-red-400 inline-block" /> 미보유
          </span>
          <span className="w-px h-3 bg-gray-700" />
          <span className="flex items-center gap-1.5 text-gray-400">
            <span className="w-5 border-t border-dashed border-gray-500 inline-block" /> 비선택 항로
          </span>
          <span className="flex items-center gap-1.5 text-sky-400">
            <span className="w-5 border-t-2 border-sky-400 inline-block" /> 선택 항로
          </span>
        </div>
      )}
    </div>
  )
}
