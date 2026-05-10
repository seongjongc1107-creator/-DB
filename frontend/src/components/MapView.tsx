import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Map, { Source, Layer, type MapRef, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as turf from '@turf/turf'
import { useApp } from '../AppContext'
import type { RouteMeta } from '../types'

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] }

const FIR_STATIC = {
  type: 'FeatureCollection' as const,
  features: [
    { type: 'Feature' as const, properties: { icao: 'RKRR', name: 'Incheon FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[122,40],[132,40],[135,37],[135,33],[130,32],[124,32],[122,34],[122,40]]] } },
    { type: 'Feature' as const, properties: { icao: 'RJJF', name: 'Fukuoka FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[130,32],[135,33],[135,37],[148,40],[148,28],[135,24],[124,24],[124,32],[130,32]]] } },
    { type: 'Feature' as const, properties: { icao: 'RJJJ', name: 'Tokyo FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[135,40],[135,50],[145,60],[160,60],[160,50],[148,40],[135,40]]] } },
    { type: 'Feature' as const, properties: { icao: 'ZSHA', name: 'Shanghai FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[110,26],[122,26],[124,32],[122,34],[122,40],[110,40],[110,26]]] } },
    { type: 'Feature' as const, properties: { icao: 'ZJSA', name: 'Sanya FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[107,10],[122,10],[122,26],[110,26],[107,22],[107,10]]] } },
    { type: 'Feature' as const, properties: { icao: 'RPHI', name: 'Manila FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[116,4],[130,4],[136,10],[136,22],[124,24],[122,18],[122,10],[116,4]]] } },
    { type: 'Feature' as const, properties: { icao: 'VHHK', name: 'Hongkong FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[107,10],[116,10],[116,22],[107,22],[107,10]]] } },
  ],
}

export default function MapView() {
  const { state, dispatch } = useApp()
  const mapRef = useRef<MapRef>(null)
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; props: Record<string, unknown> } | null>(null)
  const [mousePos, setMousePos] = useState<[number, number] | null>(null)
  const [mapLoaded, setMapLoaded] = useState(false)

  // FIR 레이어: react-map-gl Source/Layer 대신 MapLibre API 직접 호출
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return

    if (!map.getSource('fir-direct')) {
      map.addSource('fir-direct', { type: 'geojson', data: FIR_STATIC as any })
      map.addLayer({ id: 'fir-d-fill', type: 'fill', source: 'fir-direct',
        paint: { 'fill-color': '#22D3EE', 'fill-opacity': 0.06 } })
      map.addLayer({ id: 'fir-d-line', type: 'line', source: 'fir-direct',
        paint: { 'line-color': '#22D3EE', 'line-width': 2 } })
      map.addLayer({ id: 'fir-d-label', type: 'symbol', source: 'fir-direct',
        layout: { 'text-field': ['get', 'icao'], 'text-size': 14, 'text-anchor': 'center' },
        paint: { 'text-color': '#22D3EE', 'text-halo-color': '#000', 'text-halo-width': 2 } })
    }
  }, [mapLoaded])

  // FIR 레이어 가시성 토글
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const vis = state.layers.fir ? 'visible' : 'none'
    ;['fir-d-fill', 'fir-d-line', 'fir-d-label'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
    })
  }, [mapLoaded, state.layers.fir])

  // ESC → 그리기 모드 취소
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && state.spatialMode !== null) {
        dispatch({ type: 'CLEAR_SPATIAL' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.spatialMode, dispatch])

  // ── Click handler ────────────────────────────────────────────────
  const onClick = useCallback((e: MapLayerMouseEvent) => {
    // Polygon drawing mode
    if (state.spatialMode === 'polygon') {
      dispatch({ type: 'ADD_SPATIAL_POINT', payload: [e.lngLat.lng, e.lngLat.lat] })
      return
    }
    // Circle center pick (only first click)
    if (state.spatialMode === 'circle' && state.spatialPoints.length === 0) {
      dispatch({ type: 'ADD_SPATIAL_POINT', payload: [e.lngLat.lng, e.lngLat.lat] })
      return
    }
    // Normal route/airway selection
    const features = e.features ?? []
    if (features.length === 0) {
      dispatch({ type: 'SET_SELECTED_ROUTES', payload: [] })
      return
    }
    const id = features[0].properties?.id as number | undefined
    if (id !== undefined) {
      dispatch({ type: 'SET_SELECTED_ROUTES', payload: [id] })
    }
  }, [state.spatialMode, state.spatialPoints.length, dispatch])

  const onMouseMove = useCallback((e: MapLayerMouseEvent) => {
    if (state.spatialMode === 'polygon') {
      setMousePos([e.lngLat.lng, e.lngLat.lat])
      return
    }
    const features = e.features ?? []
    if (features.length > 0) {
      const f = features[0]
      const id = f.properties?.id as number | undefined
      setHoveredId(id ?? null)
      setTooltip({ x: e.point.x, y: e.point.y, props: f.properties ?? {} })
    } else {
      setHoveredId(null)
      setTooltip(null)
    }
  }, [state.spatialMode])

  const onMouseLeave = useCallback(() => {
    setHoveredId(null)
    setTooltip(null)
    setMousePos(null)
  }, [])

  // ── FlyTo effect ────────────────────────────────────────────────
  useEffect(() => {
    if (!state.pendingFlyTo || !mapRef.current) return
    mapRef.current.flyTo({
      center: [state.pendingFlyTo.lon, state.pendingFlyTo.lat],
      zoom: state.pendingFlyTo.zoom ?? 8,
      duration: 1000,
    })
    dispatch({ type: 'SET_FLY_TO', payload: null })
  }, [state.pendingFlyTo, dispatch])

  // ── Highlight points GeoJSON ─────────────────────────────────────
  const highlightData = useMemo(() => {
    const features = state.highlightPoints
      .filter(p => p.lat !== null && p.lon !== null)
      .map(p => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lon!, p.lat!] },
        properties: { id: p.id, itemType: p.type, name: p.name },
      }))
    return { type: 'FeatureCollection' as const, features }
  }, [state.highlightPoints])

  // ── Base data ────────────────────────────────────────────────────
  const routeData = state.routeGeoJSON ?? EMPTY_FC
  const airportsData = state.airportsGeoJSON ?? EMPTY_FC
  const waypointsData = state.waypointsGeoJSON ?? EMPTY_FC
  const airwayData = state.airwayGeoJSON ?? EMPTY_FC
  const firData = state.firGeoJSON
  const selectedIds = state.selectedRouteIds

  // ── Typhoon circles ──────────────────────────────────────────────
  const typhoonData = useMemo(() => {
    if (state.typhoons.length === 0) return EMPTY_FC
    const features = state.typhoons.flatMap(t => {
      const center: [number, number] = [t.lon, t.lat]
      const circle = turf.circle(center, t.radius_nm, { steps: 64, units: 'nauticalmiles' })
      return [
        { ...circle, properties: { id: t.id, name: t.name, color: t.color, radius_nm: t.radius_nm } },
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: center },
          properties: { id: t.id, name: t.name, color: t.color, wind_kt: t.wind_kt },
        },
      ]
    })
    return { type: 'FeatureCollection' as const, features: features as any[] }
  }, [state.typhoons])

  // ── Typhoon track path ───────────────────────────────────────────
  const typhoonTrackData = useMemo(() => {
    const track = state.typhoonTrack
    if (!track || track.length < 2) return EMPTY_FC
    const step = state.typhoonTrackStep
    const features: object[] = [
      // full path (faint)
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: track.map(p => [p.lon, p.lat]) },
        properties: { kind: 'full' },
      },
      // past path (solid)
      ...(step > 0 ? [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: track.slice(0, step + 1).map(p => [p.lon, p.lat]) },
        properties: { kind: 'past' },
      }] : []),
      // all track dots
      ...track.map((p, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { kind: 'dot', past: i <= step, current: i === step, color: p.color },
      })),
    ]
    return { type: 'FeatureCollection' as const, features: features as any[] }
  }, [state.typhoonTrack, state.typhoonTrackStep])

  // ── In-progress drawing layer ────────────────────────────────────
  const drawingData = useMemo(() => {
    const pts = state.spatialPoints
    if (pts.length === 0) return EMPTY_FC

    const features: object[] = []

    if (state.spatialMode === 'polygon') {
      // Line through drawn points + live mouse preview
      const linePts = mousePos ? [...pts, mousePos] : pts
      if (linePts.length >= 2) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: linePts },
          properties: {},
        })
      }
      // Vertex dots
      pts.forEach((p, i) => {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: p },
          properties: { idx: i },
        })
      })
    } else if (state.spatialMode === 'circle' && pts.length === 1) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pts[0] },
        properties: {},
      })
    }

    return { type: 'FeatureCollection' as const, features: features as any[] }
  }, [state.spatialPoints, state.spatialMode, mousePos])

  // ── Active spatial filter layer (polygon/circle outline) ─────────
  const spatialFilterData = useMemo(() => {
    if (!state.spatialFilter) return EMPTY_FC
    return {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [state.spatialFilter.ring] },
        properties: {},
      }],
    }
  }, [state.spatialFilter])

  // ── Spatial route filtering with turf ────────────────────────────
  const spatialRoutesData = useMemo(() => {
    if (!state.spatialFilter) return null
    const filterPoly = turf.polygon([state.spatialFilter.ring])
    const features = routeData.features.filter(f => {
      try { return turf.booleanIntersects(f as any, filterPoly) }
      catch { return false }
    })
    return { type: 'FeatureCollection' as const, features }
  }, [state.spatialFilter, routeData])

  // Update route list panel when spatial filter result changes
  useEffect(() => {
    if (!spatialRoutesData) return
    const routes: RouteMeta[] = spatialRoutesData.features.map(f => ({
      id: f.properties?.id as number,
      origin: f.properties?.origin as string,
      destination: f.properties?.destination as string,
      number: f.properties?.number as number,
      route: f.properties?.route as string,
      distance: f.properties?.distance as number,
      disabled: false,
      aircraft: (f.properties?.aircraft ?? '') as string,
    }))
    dispatch({ type: 'SET_ALL_ROUTES', payload: routes })
    dispatch({ type: 'SET_SELECTED_ROUTES', payload: [] })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spatialRoutesData])

  // Clear route list when spatial filter is removed
  useEffect(() => {
    if (state.spatialFilter === null && !state.spatialMode) {
      // Restore full list only if nothing else is filtering
      if (!state.origin && !state.destination && !state.activeAirway) {
        import('../api/client').then(({ api }) => {
          api.routes.list().then(d => dispatch({ type: 'SET_ALL_ROUTES', payload: d.routes }))
        })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.spatialFilter])

  // ── Matched/searched routes data ────────────────────────────────
  const searchedRoutesData = useMemo(() => {
    // 대체 항로 모드: 클릭한 대체 항로를 우선 표시
    if (state.altRouteMode && state.matchedRoutesGeoJSON) return state.matchedRoutesGeoJSON
    if (spatialRoutesData) return spatialRoutesData
    if (state.matchedRoutesGeoJSON) return state.matchedRoutesGeoJSON
    if (selectedIds.length === 0) return EMPTY_FC
    const idSet = new Set(selectedIds)
    const features = routeData.features.filter(
      f => idSet.has(f.properties?.id as number)
    )
    return { type: 'FeatureCollection' as const, features }
  }, [state.altRouteMode, spatialRoutesData, state.matchedRoutesGeoJSON, selectedIds, routeData])

  const inDrawMode = state.spatialMode !== null

  return (
    <div className="relative w-full h-full">
      <Map
        ref={mapRef}
        mapStyle={MAP_STYLE}
        initialViewState={{ longitude: 127, latitude: 35, zoom: 4 }}
        style={{ width: '100%', height: '100%' }}
        interactiveLayerIds={
          inDrawMode ? [] : ['routes-line', 'airports-circle', 'airway-line', 'searched-routes-line']
        }
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseOut={onMouseLeave}
        cursor={inDrawMode ? 'crosshair' : hoveredId !== null ? 'pointer' : 'grab'}
      >
        {/* ── FIR Boundaries ──────────────────────────────────────── */}
        {true && (
          <Source id="fir" type="geojson" data={FIR_STATIC}>
            <Layer
              id="fir-fill"
              type="fill"
              layout={{ visibility: state.layers.fir ? 'visible' : 'none' }}
              paint={{ 'fill-color': '#22D3EE', 'fill-opacity': 0.05 }}
            />
            <Layer
              id="fir-line"
              type="line"
              layout={{ visibility: state.layers.fir ? 'visible' : 'none' }}
              paint={{ 'line-color': '#22D3EE', 'line-width': 2, 'line-opacity': 0.9 }}
            />
            <Layer
              id="fir-label"
              type="symbol"
              layout={{
                visibility: state.layers.fir ? 'visible' : 'none',
                'text-field': ['get', 'icao'],
                'text-size': 14,
                'text-anchor': 'center',
              }}
              paint={{ 'text-color': '#22D3EE', 'text-opacity': 0.9, 'text-halo-color': '#000', 'text-halo-width': 2 }}
            />
          </Source>
        )}

        {/* ── Navblue Routes ──────────────────────────────────────── */}
        <Source id="routes" type="geojson" data={routeData}>
          <Layer
            id="routes-line"
            type="line"
            layout={{ visibility: state.layers.routes ? 'visible' : 'none' }}
            paint={{
              'line-color': '#3B82F6',
              'line-width': 1.2,
              'line-opacity': 0.45,
            }}
          />
        </Source>

        {/* ── Airports ─────────────────────────────────────────────── */}
        <Source id="airports" type="geojson" data={airportsData}>
          <Layer
            id="airports-circle"
            type="circle"
            layout={{ visibility: state.layers.airports ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 5,
              'circle-color': '#EF4444',
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 1.5,
            }}
          />
          <Layer
            id="airports-label"
            type="symbol"
            minzoom={5}
            layout={{
              visibility: state.layers.airports ? 'visible' : 'none',
              'text-field': ['get', 'id'],
              'text-size': 10,
              'text-offset': [0, 1.2],
              'text-anchor': 'top',
            }}
            paint={{ 'text-color': '#EF4444', 'text-halo-color': '#fff', 'text-halo-width': 1.5 }}
          />
        </Source>

        {/* ── Waypoints ─────────────────────────────────────────────── */}
        <Source id="waypoints" type="geojson" data={waypointsData}>
          <Layer
            id="waypoints-circle"
            type="circle"
            minzoom={6}
            layout={{ visibility: state.layers.waypoints ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 3,
              'circle-color': '#fff',
              'circle-stroke-color': '#6B7280',
              'circle-stroke-width': 1,
            }}
          />
          <Layer
            id="waypoints-label"
            type="symbol"
            minzoom={8}
            layout={{
              visibility: state.layers.waypoints ? 'visible' : 'none',
              'text-field': ['get', 'id'],
              'text-size': 9,
              'text-offset': [0, 1],
              'text-anchor': 'top',
            }}
            paint={{ 'text-color': '#4B5563', 'text-halo-color': '#fff', 'text-halo-width': 1 }}
          />
        </Source>

        {/* ── 검색 결과 항로 (초록 실선) ──────────────────────────── */}
        <Source id="searched-routes" type="geojson" data={searchedRoutesData}>
          <Layer
            id="searched-routes-line"
            type="line"
            layout={{ visibility: state.layers.matchedRoutes ? 'visible' : 'none' }}
            paint={{
              'line-color': '#10B981',
              'line-width': 2.5,
              'line-opacity': 0.9,
            }}
          />
        </Source>

        {/* ── Airway 자체 경로 — 흰색 케이싱 + 노란 실선, 최상단 ── */}
        <Source id="airway" type="geojson" data={airwayData}>
          {/* White casing so the line is visible over any background */}
          <Layer
            id="airway-casing"
            type="line"
            layout={{ visibility: state.layers.activeAirway ? 'visible' : 'none' }}
            paint={{ 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.6 }}
          />
          <Layer
            id="airway-line"
            type="line"
            layout={{ visibility: state.layers.activeAirway ? 'visible' : 'none' }}
            paint={{
              'line-color': '#FBBF24',
              'line-width': 3,
              'line-opacity': 1,
            }}
          />
          <Layer
            id="airway-label"
            type="symbol"
            layout={{
              visibility: state.layers.activeAirway ? 'visible' : 'none',
              'text-field': ['get', 'airway'],
              'text-size': 12,
              'symbol-placement': 'line-center',
            }}
            paint={{ 'text-color': '#FBBF24', 'text-halo-color': '#1a1a1a', 'text-halo-width': 2 }}
          />
        </Source>

        {/* ── Typhoon circles ─────────────────────────────────────── */}
        <Source id="typhoon" type="geojson" data={typhoonData}>
          <Layer
            id="typhoon-fill"
            type="fill"
            filter={['==', '$type', 'Polygon']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 }}
          />
          <Layer
            id="typhoon-stroke"
            type="line"
            filter={['==', '$type', 'Polygon']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{ 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [5, 3] }}
          />
          <Layer
            id="typhoon-center"
            type="circle"
            filter={['==', '$type', 'Point']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 6,
              'circle-color': ['get', 'color'],
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 2,
            }}
          />
          <Layer
            id="typhoon-label"
            type="symbol"
            filter={['==', '$type', 'Point']}
            layout={{
              visibility: state.layers.typhoon ? 'visible' : 'none',
              'text-field': ['get', 'name'],
              'text-size': 11,
              'text-offset': [0, 1.5],
              'text-anchor': 'top',
            }}
            paint={{ 'text-color': ['get', 'color'], 'text-halo-color': '#111', 'text-halo-width': 2 }}
          />
        </Source>

        {/* ── Typhoon track path ──────────────────────────────────── */}
        <Source id="typhoon-track" type="geojson" data={typhoonTrackData}>
          <Layer
            id="typhoon-track-full"
            type="line"
            filter={['==', ['get', 'kind'], 'full']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{ 'line-color': '#6B7280', 'line-width': 1.5, 'line-dasharray': [3, 3] }}
          />
          <Layer
            id="typhoon-track-past"
            type="line"
            filter={['==', ['get', 'kind'], 'past']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{ 'line-color': '#fff', 'line-width': 2, 'line-opacity': 0.6 }}
          />
          <Layer
            id="typhoon-track-dots"
            type="circle"
            filter={['==', ['get', 'kind'], 'dot']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{
              'circle-radius': ['case', ['get', 'current'], 5, 3],
              'circle-color': ['get', 'color'],
              'circle-opacity': ['case', ['get', 'past'], 1, 0.35],
              'circle-stroke-color': '#fff',
              'circle-stroke-width': ['case', ['get', 'current'], 2, 0],
            }}
          />
        </Source>

        {/* ── Spatial filter polygon outline ───────────────────────── */}
        <Source id="spatial-filter" type="geojson" data={spatialFilterData}>
          <Layer
            id="spatial-fill"
            type="fill"
            paint={{ 'fill-color': '#A855F7', 'fill-opacity': 0.08 }}
          />
          <Layer
            id="spatial-outline"
            type="line"
            paint={{ 'line-color': '#A855F7', 'line-width': 2, 'line-dasharray': [4, 2] }}
          />
        </Source>

        {/* ── Search highlights (selected airports / waypoints) ─────── */}
        <Source id="highlights" type="geojson" data={highlightData}>
          <Layer
            id="highlights-halo"
            type="circle"
            paint={{
              'circle-radius': 16,
              'circle-color': [
                'match', ['get', 'itemType'],
                'airport', '#F97316',
                'waypoint', '#06B6D4',
                '#A855F7',
              ],
              'circle-opacity': 0.2,
              'circle-blur': 0.5,
            }}
          />
          <Layer
            id="highlights-circle"
            type="circle"
            paint={{
              'circle-radius': 9,
              'circle-color': [
                'match', ['get', 'itemType'],
                'airport', '#F97316',
                'waypoint', '#06B6D4',
                '#A855F7',
              ],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2.5,
            }}
          />
          <Layer
            id="highlights-label"
            type="symbol"
            layout={{
              'text-field': ['get', 'name'],
              'text-size': 11,
              'text-offset': [0, 1.6],
              'text-anchor': 'top',
            }}
            paint={{
              'text-color': [
                'match', ['get', 'itemType'],
                'airport', '#F97316',
                'waypoint', '#06B6D4',
                '#A855F7',
              ],
              'text-halo-color': '#111827',
              'text-halo-width': 2,
            }}
          />
        </Source>

        {/* ── In-progress drawing ──────────────────────────────────── */}
        <Source id="drawing" type="geojson" data={drawingData}>
          <Layer
            id="drawing-line"
            type="line"
            filter={['==', '$type', 'LineString']}
            paint={{ 'line-color': '#A855F7', 'line-width': 2, 'line-dasharray': [4, 2] }}
          />
          <Layer
            id="drawing-points"
            type="circle"
            filter={['==', '$type', 'Point']}
            paint={{ 'circle-radius': 5, 'circle-color': '#A855F7', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 }}
          />
        </Source>
      </Map>

      {/* Tooltip */}
      {tooltip && !inDrawMode && (
        <div
          className="absolute bg-gray-900 border border-gray-700 text-white text-xs rounded-lg shadow-xl p-2.5 pointer-events-none z-10 max-w-xs"
          style={{ left: tooltip.x + 14, top: tooltip.y - 8 }}
        >
          {tooltip.props.origin && tooltip.props.destination ? (
            <>
              <div className="font-bold text-sm text-white">
                {tooltip.props.origin as string}–{tooltip.props.destination as string}
                <span className="ml-1 text-yellow-400 font-semibold">
                  #{tooltip.props.number as number}
                </span>
              </div>
              {tooltip.props.distance && (
                <div className="text-gray-400 mt-1">{tooltip.props.distance as number} NM</div>
              )}
              {tooltip.props.route && (
                <div className="text-gray-400 mt-1 break-all leading-relaxed">
                  {tooltip.props.route as string}
                </div>
              )}
            </>
          ) : tooltip.props.airway ? (
            <div className="font-semibold text-green-400">{tooltip.props.airway as string}</div>
          ) : null}
        </div>
      )}

      {/* Draw mode hint */}
      {inDrawMode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-gray-900/90 border border-purple-600 text-purple-300 text-xs rounded-lg px-3 py-2 pointer-events-none z-10">
          {state.spatialMode === 'polygon'
            ? `클릭으로 꼭짓점 추가 (${state.spatialPoints.length}개) — 사이드바에서 완료 버튼 클릭`
            : state.spatialPoints.length === 0
              ? '지도에서 중심점을 클릭하세요'
              : '사이드바에서 반경을 입력하고 적용하세요'}
        </div>
      )}
    </div>
  )
}
