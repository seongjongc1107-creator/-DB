import type { DummyFlight } from './types'

export const SEASONS: Record<string, { label: string; from: string; to: string }> = {
  S26: { label: 'Summer 2026', from: '2026-04-01', to: '2026-10-25' },
  W26: { label: 'Winter 2026', from: '2026-10-26', to: '2027-03-28' },
}

export const COUNTRY_POLYGONS: Record<string, { coords: number[][][]; name: string }> = {
  CN: { name: 'China',        coords: [[[73,18],[135,18],[135,53],[73,53],[73,18]]] },
  KZ: { name: 'Kazakhstan',   coords: [[[51,40],[87,40],[87,56],[51,56],[51,40]]] },
  UZ: { name: 'Uzbekistan',   coords: [[[56,37],[73,37],[73,46],[56,46],[56,37]]] },
  TM: { name: 'Turkmenistan', coords: [[[52,35],[66,35],[66,43],[52,43],[52,35]]] },
  AZ: { name: 'Azerbaijan',   coords: [[[44,38],[51,38],[51,42],[44,42],[44,38]]] },
  TR: { name: 'Turkey',       coords: [[[26,36],[45,36],[45,42],[26,42],[26,36]]] },
  GR: { name: 'Greece',       coords: [[[20,35],[27,35],[27,42],[20,42],[20,35]]] },
  IR: { name: 'Iran',         coords: [[[44,25],[64,25],[64,40],[44,40],[44,25]]] },
  JP: { name: 'Japan',        coords: [[[129,31],[146,31],[146,46],[129,46],[129,31]]] },
  CA: { name: 'Canada',       coords: [[[-141,42],[-52,42],[-52,70],[-141,70],[-141,42]]] },
  RU: { name: 'Russia',       coords: [[[27,50],[180,50],[180,82],[27,82],[27,50]]] },
  MN: { name: 'Mongolia',     coords: [[[87,41],[120,41],[120,52],[87,52],[87,41]]] },
  VN: { name: 'Vietnam',      coords: [[[102,8],[110,8],[110,24],[102,24],[102,8]]] },
  IN: { name: 'India',        coords: [[[68,8],[97,8],[97,36],[68,36],[68,8]]] },
  PK: { name: 'Pakistan',     coords: [[[60,23],[77,23],[77,37],[60,37],[60,23]]] },
}

export const DUMMY_FLIGHTS: Record<string, DummyFlight> = {
  'KE901': {
    info: {
      flightNumber: 'KE901',
      airline: 'Korean Air (KE)',
      origin: 'ICN',
      destination: 'LHR',
      aircraftType: 'B777-300ER',
      registration: 'HL8009',
      depTimeUtc: '00:35',
    },
    routes: [
      {
        routeNumber: 1,
        routeName: 'Trans-Siberian',
        routeString: 'RKSI DCT BUNTA R218 ESLOV G344 DEVOL B345 ENITA W41 RATNO G20 VEKEN L43 LHR',
        routeCoords: [
          [126.5,37.5],[133,42],[130,50],[118,56],
          [100,60],[80,58],[62,54],[50,52],
          [40,47],[32,41],[25,40],[15,43],[5,47],[-0.46,51.5],
        ],
        distance: 4698,
        permits: [
          {
            countryCode: 'RU', countryName: 'Russia', flag: '🇷🇺',
            entryCoord: [125,52], permitType: 'OverFlight', status: 'not_held',
            entryFix: 'BUNTA', exitFix: 'DEVOL',
          },
          {
            countryCode: 'KZ', countryName: 'Kazakhstan', flag: '🇰🇿',
            entryCoord: [60,52], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'DEVOL', exitFix: 'ROTAR', cruiseLevel: 'FL350', transitWindow: '05:10~05:40 UTC',
          },
          {
            countryCode: 'AZ', countryName: 'Azerbaijan', flag: '🇦🇿',
            entryCoord: [47,42], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'ROTAR', exitFix: 'VEKEN', cruiseLevel: 'FL350', transitWindow: '05:40~06:10 UTC',
          },
          {
            countryCode: 'TR', countryName: 'Turkey', flag: '🇹🇷',
            entryCoord: [35,40], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'VEKEN', exitFix: 'ULADA', cruiseLevel: 'FL370', transitWindow: '06:10~07:00 UTC',
          },
          {
            countryCode: 'GR', countryName: 'Greece', flag: '🇬🇷',
            entryCoord: [23,40], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'ULADA', exitFix: 'ARMID', cruiseLevel: 'FL370', transitWindow: '07:00~07:25 UTC',
          },
        ],
      },
      {
        routeNumber: 2,
        routeName: 'Central Asia',
        routeString: 'RKSI DCT OLMEN Y711 MUBAK A593 BOBTU L888 IGMOT G221 LATVO B330 ESOBA P894 ROVUS B557 DIVKO UL975 LHR',
        routeCoords: [
          [126.5,37.5],[122,38],[116,38],[108,39],[100,41],
          [90,43],[80,44],[72,44],[63,40],[57,38],
          [51,39],[43,40],[35,37],[28,41],[22,40],
          [14,41],[7,44],[2,47],[-0.46,51.5],
        ],
        distance: 5224,
        permits: [
          {
            countryCode: 'CN', countryName: 'China', flag: '🇨🇳',
            entryCoord: [108,39], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'MUBAK', exitFix: 'BOBTU', cruiseLevel: 'FL350', transitWindow: '15:30~17:00 UTC',
          },
          {
            countryCode: 'MN', countryName: 'Mongolia', flag: '🇲🇳',
            entryCoord: [100,43], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'LOTKU', exitFix: 'IGMOT', cruiseLevel: 'FL350', transitWindow: '16:00~16:30 UTC',
          },
          {
            countryCode: 'KZ', countryName: 'Kazakhstan', flag: '🇰🇿',
            entryCoord: [76,44], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'LATVO', exitFix: 'ESOBA', cruiseLevel: 'FL350', transitWindow: '17:00~17:45 UTC',
          },
          {
            countryCode: 'UZ', countryName: 'Uzbekistan', flag: '🇺🇿',
            entryCoord: [62,40], permitType: 'OverFlight',
            status: 'expiring', validFrom: '2026-04-01', validTo: '2026-06-15',
            entryFix: 'ESOBA', exitFix: 'ROVUS', cruiseLevel: 'FL350', transitWindow: '17:45~18:15 UTC',
          },
          {
            countryCode: 'TM', countryName: 'Turkmenistan', flag: '🇹🇲',
            entryCoord: [57,38], permitType: 'OverFlight', status: 'not_held',
            entryFix: 'ROVUS', exitFix: 'DIVKO',
          },
          {
            countryCode: 'AZ', countryName: 'Azerbaijan', flag: '🇦🇿',
            entryCoord: [49,40], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'ROVUS', exitFix: 'DIVKO', cruiseLevel: 'FL350', transitWindow: '18:15~18:45 UTC',
          },
          {
            countryCode: 'TR', countryName: 'Turkey', flag: '🇹🇷',
            entryCoord: [35,38], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'DIVKO', exitFix: 'ULADA', cruiseLevel: 'FL370', transitWindow: '18:45~19:30 UTC',
          },
          {
            countryCode: 'GR', countryName: 'Greece', flag: '🇬🇷',
            entryCoord: [23,39], permitType: 'OverFlight',
            status: 'expiring', validFrom: '2026-04-01', validTo: '2026-05-31',
            entryFix: 'ULADA', exitFix: 'ARMID', cruiseLevel: 'FL370', transitWindow: '19:30~19:55 UTC',
          },
        ],
      },
      {
        routeNumber: 3,
        routeName: 'Southern',
        routeString: 'RKSI SURGU AGAVO Y644 REBIT B339 DUMIL G792 MEVDO P628 VELOX N563 SOLUM A791 IRANO UL135 LHR',
        routeCoords: [
          [126.5,37.5],[118,30],[110,22],[104,18],[96,18],
          [85,22],[77,28],[67,26],[57,28],[50,32],
          [44,37],[35,38],[28,41],[22,40],[14,41],
          [7,44],[2,47],[-0.46,51.5],
        ],
        distance: 5832,
        permits: [
          {
            countryCode: 'CN', countryName: 'China', flag: '🇨🇳',
            entryCoord: [110,28], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'SURGU', exitFix: 'DUMIL', cruiseLevel: 'FL350', transitWindow: '15:30~16:15 UTC',
          },
          {
            countryCode: 'VN', countryName: 'Vietnam', flag: '🇻🇳',
            entryCoord: [104,18], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'DUMIL', exitFix: 'MEVDO', cruiseLevel: 'FL350', transitWindow: '16:15~16:45 UTC',
          },
          {
            countryCode: 'IN', countryName: 'India', flag: '🇮🇳',
            entryCoord: [82,22], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'MEVDO', exitFix: 'VELOX', cruiseLevel: 'FL360', transitWindow: '16:45~17:45 UTC',
          },
          {
            countryCode: 'PK', countryName: 'Pakistan', flag: '🇵🇰',
            entryCoord: [67,27], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'VELOX', exitFix: 'SOLUM', cruiseLevel: 'FL360', transitWindow: '17:45~18:20 UTC',
          },
          {
            countryCode: 'IR', countryName: 'Iran', flag: '🇮🇷',
            entryCoord: [55,30], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'SOLUM', exitFix: 'IRANO', cruiseLevel: 'FL360', transitWindow: '18:20~19:10 UTC',
          },
          {
            countryCode: 'TR', countryName: 'Turkey', flag: '🇹🇷',
            entryCoord: [35,37], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'IRANO', exitFix: 'ULADA', cruiseLevel: 'FL370', transitWindow: '19:10~20:00 UTC',
          },
          {
            countryCode: 'GR', countryName: 'Greece', flag: '🇬🇷',
            entryCoord: [23,40], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'ULADA', exitFix: 'ARMID', cruiseLevel: 'FL370', transitWindow: '20:00~20:25 UTC',
          },
        ],
      },
    ],
  },

  'KE085': {
    info: {
      flightNumber: 'KE085',
      airline: 'Korean Air (KE)',
      origin: 'ICN',
      destination: 'FRA',
      aircraftType: 'A380-800',
      registration: 'HL7612',
      depTimeUtc: '01:10',
    },
    routes: [
      {
        routeNumber: 1,
        routeName: 'Central Asia',
        routeString: 'RKSI DCT OLMEN Y711 MUBAK A593 BOBTU L888 IGMOT G221 LATVO B330 ESOBA P894 SORIX UB301 DUKAN FRA',
        routeCoords: [
          [126.5,37.5],[122,38],[116,38],[108,39],[100,41],
          [90,43],[80,44],[72,44],[63,40],[57,38],
          [52,36],[48,35],[40,37],[33,38],
          [25,40],[18,42],[12,44],[8.5,50],
        ],
        distance: 5124,
        permits: [
          {
            countryCode: 'CN', countryName: 'China', flag: '🇨🇳',
            entryCoord: [108,39], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'MUBAK', exitFix: 'BOBTU', cruiseLevel: 'FL350', transitWindow: '15:30~17:00 UTC',
          },
          {
            countryCode: 'KZ', countryName: 'Kazakhstan', flag: '🇰🇿',
            entryCoord: [76,44], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'LATVO', exitFix: 'ESOBA', cruiseLevel: 'FL350', transitWindow: '17:00~17:45 UTC',
          },
          {
            countryCode: 'UZ', countryName: 'Uzbekistan', flag: '🇺🇿',
            entryCoord: [62,40], permitType: 'OverFlight', status: 'not_held',
            entryFix: 'ESOBA', exitFix: 'SORIX',
          },
          {
            countryCode: 'TM', countryName: 'Turkmenistan', flag: '🇹🇲',
            entryCoord: [57,37], permitType: 'OverFlight', status: 'not_held',
            entryFix: 'SORIX', exitFix: 'DUKAN',
          },
          {
            countryCode: 'IR', countryName: 'Iran', flag: '🇮🇷',
            entryCoord: [52,35], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'SORIX', exitFix: 'DUKAN', cruiseLevel: 'FL350', transitWindow: '18:15~19:00 UTC',
          },
          {
            countryCode: 'TR', countryName: 'Turkey', flag: '🇹🇷',
            entryCoord: [35,38], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'DUKAN', exitFix: 'ULADA', cruiseLevel: 'FL370', transitWindow: '19:00~19:45 UTC',
          },
        ],
      },
      {
        routeNumber: 2,
        routeName: 'Trans-Siberian',
        routeString: 'RKSI DCT BUNTA R218 ESLOV G344 DEVOL B345 ENITA W41 RATNO M999 FRA',
        routeCoords: [
          [126.5,37.5],[133,42],[130,50],[118,56],[100,60],
          [80,58],[62,54],[50,52],[40,48],[32,44],
          [25,43],[18,45],[12,46],[8.5,50],
        ],
        distance: 4892,
        permits: [
          {
            countryCode: 'RU', countryName: 'Russia', flag: '🇷🇺',
            entryCoord: [125,52], permitType: 'OverFlight', status: 'not_held',
            entryFix: 'BUNTA', exitFix: 'DEVOL',
          },
          {
            countryCode: 'KZ', countryName: 'Kazakhstan', flag: '🇰🇿',
            entryCoord: [60,52], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'DEVOL', exitFix: 'ROTAR', cruiseLevel: 'FL350', transitWindow: '05:10~05:40 UTC',
          },
          {
            countryCode: 'AZ', countryName: 'Azerbaijan', flag: '🇦🇿',
            entryCoord: [47,42], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'ROTAR', exitFix: 'VEKEN', cruiseLevel: 'FL350', transitWindow: '05:40~06:10 UTC',
          },
          {
            countryCode: 'TR', countryName: 'Turkey', flag: '🇹🇷',
            entryCoord: [35,40], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'VEKEN', exitFix: 'ULADA', cruiseLevel: 'FL370', transitWindow: '06:10~07:00 UTC',
          },
        ],
      },
    ],
  },

  'KE017': {
    info: {
      flightNumber: 'KE017',
      airline: 'Korean Air (KE)',
      origin: 'ICN',
      destination: 'JFK',
      aircraftType: 'B777-200ER',
      registration: 'HL7530',
      depTimeUtc: '22:00',
    },
    routes: [
      {
        routeNumber: 1,
        routeName: 'North Pacific',
        routeString: 'RKSI DCT RJJJ GRISE FUMES OAKEY DARIT MERIT DOTTY JOOPY TULEG SEBUS LINND RAFOX JFK',
        routeCoords: [
          [126.5,37.5],[130,35],[138,36],[145,40],
          [155,45],[165,50],[175,54],
          [-178,56],[-168,58],[-155,60],
          [-140,62],[-125,57],[-112,52],
          [-95,47],[-82,44],[-73.8,40.6],
        ],
        distance: 6886,
        permits: [
          {
            countryCode: 'JP', countryName: 'Japan', flag: '🇯🇵',
            entryCoord: [136,37], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'GRISE', exitFix: 'FUMES', cruiseLevel: 'FL350', transitWindow: '13:10~13:45 UTC',
          },
          {
            countryCode: 'CA', countryName: 'Canada', flag: '🇨🇦',
            entryCoord: [-130,57], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'MERIT', exitFix: 'DOTTY', cruiseLevel: 'FL370', transitWindow: '03:20~05:10 UTC',
          },
        ],
      },
      {
        routeNumber: 2,
        routeName: 'Polar',
        routeString: 'RKSI DCT RJJJ ELBON NUZAN RATUK KODAP MIMKU NESET DOLIR PESAT RAFOX JFK',
        routeCoords: [
          [126.5,37.5],[132,38],[138,45],
          [145,55],[148,65],[148,75],
          [120,80],[90,82],[60,80],
          [30,75],[10,68],[-20,62],
          [-50,58],[-65,53],[-73.8,40.6],
        ],
        distance: 6520,
        permits: [
          {
            countryCode: 'JP', countryName: 'Japan', flag: '🇯🇵',
            entryCoord: [136,42], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'ELBON', exitFix: 'NUZAN', cruiseLevel: 'FL360', transitWindow: '13:00~13:30 UTC',
          },
          {
            countryCode: 'RU', countryName: 'Russia', flag: '🇷🇺',
            entryCoord: [148,68], permitType: 'OverFlight', status: 'not_held',
            entryFix: 'NUZAN', exitFix: 'NESET',
          },
          {
            countryCode: 'CA', countryName: 'Canada', flag: '🇨🇦',
            entryCoord: [-55,57], permitType: 'OverFlight',
            status: 'valid', validFrom: '2026-04-01', validTo: '2026-10-25',
            entryFix: 'DOLIR', exitFix: 'PESAT', cruiseLevel: 'FL370', transitWindow: '17:30~19:10 UTC',
          },
        ],
      },
    ],
  },

  'OZ201': {
    info: {
      flightNumber: 'OZ201',
      airline: 'Asiana Airlines (OZ)',
      origin: 'ICN',
      destination: 'LAX',
      aircraftType: 'A350-900',
      registration: 'HL8079',
      depTimeUtc: '21:30',
    },
    routes: [
      {
        routeNumber: 1,
        routeName: 'North Pacific',
        routeString: 'RKSI DCT RJJJ ADNAP BEENO CLAWD MOSBI LUBID RAKFO LUCKS TONTO LOSHN SKOLL LAX',
        routeCoords: [
          [126.5,37.5],[130,34],[138,34],[145,36],
          [152,38],[160,40],[168,42],[175,44],
          [-178,45],[-170,44],[-162,40],
          [-152,36],[-142,33],[-130,30],
          [-118.4,33.9],
        ],
        distance: 5971,
        permits: [
          {
            countryCode: 'JP', countryName: 'Japan', flag: '🇯🇵',
            entryCoord: [136,35], permitType: 'OverFlight',
            status: 'expiring', validFrom: '2026-04-01', validTo: '2026-05-20',
            entryFix: 'ADNAP', exitFix: 'BEENO', cruiseLevel: 'FL350', transitWindow: '12:45~13:20 UTC',
          },
        ],
      },
      {
        routeNumber: 2,
        routeName: 'Polar',
        routeString: 'RKSI DCT RJJJ ELBON NUZAN RATUK KODAP MIMKU SKOLL LAX',
        routeCoords: [
          [126.5,37.5],[132,38],[138,45],
          [145,55],[148,65],[148,75],
          [100,82],[40,80],[-10,72],
          [-60,60],[-100,55],[-118.4,33.9],
        ],
        distance: 5740,
        permits: [
          {
            countryCode: 'JP', countryName: 'Japan', flag: '🇯🇵',
            entryCoord: [136,42], permitType: 'OverFlight',
            status: 'expiring', validFrom: '2026-04-01', validTo: '2026-05-20',
            entryFix: 'ELBON', exitFix: 'NUZAN', cruiseLevel: 'FL360', transitWindow: '12:30~13:00 UTC',
          },
          {
            countryCode: 'RU', countryName: 'Russia', flag: '🇷🇺',
            entryCoord: [148,68], permitType: 'OverFlight', status: 'not_held',
            entryFix: 'NUZAN', exitFix: 'KODAP',
          },
        ],
      },
    ],
  },
}
