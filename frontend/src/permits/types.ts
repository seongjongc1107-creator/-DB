export type PermitStatus = 'valid' | 'expiring' | 'not_held'

export interface FlightInfo {
  flightNumber: string
  airline: string
  origin: string
  destination: string
  aircraftType: string
  registration: string
  depTimeUtc: string
}

export interface CountryPermit {
  countryCode: string
  countryName: string
  flag: string
  entryCoord: [number, number]
  permitType: string
  status: PermitStatus
  validFrom?: string
  validTo?: string
  entryFix?: string
  exitFix?: string
  cruiseLevel?: string
  transitWindow?: string
}

export interface RouteOption {
  routeNumber: number
  routeName: string
  routeString: string
  routeCoords: [number, number][]
  distance: number
  permits: CountryPermit[]
}

export interface DummyFlight {
  info: FlightInfo
  routes: RouteOption[]
}

export interface PermitApplication {
  id: string
  flightNumber: string
  routeNumber: number
  season: string
  countryCode: string
  countryName: string
  airline: string
  origin: string
  destination: string
  aircraftType: string
  registration: string
  periodFrom: string
  periodTo: string
  entryFix: string
  exitFix: string
  cruiseLevel: string
  transitWindow: string
  frequency: string
  contactInfo: string
  notes: string
  status: 'draft' | 'submitted'
  createdAt: string
}
