// Equatorial Radius
const EARTH_RADIUS = 6378137.0;

/**
 * Solution to a distance between two points on Earth problem
 * 
 * @field distance between points in meters
 * @field initialBearing angle relative to true north in radians
 * @field finalBearing angle relative to true north in radians
 */
interface Solution {
    distance: number,
    initialBearing: number,
    finalBearing: number
}

/**
 * Conversion from degrees to radians
 *
 * @param deg angle in degrees
 * @return angle in radians
 */
export function degToRad (deg: number): number {
    return (deg * (Math.PI / 180.0))
 };
 
 /**
  * Conversion from radians to degrees
  *
  * @param rad angle in radians
  * @return angle in degrees
  */
export function radToDeg (rad:number): number {
    return (180.0 * (rad / Math.PI));
 };


 /** 
  * Haversine distance formula
  * Assuming Earth is a sphere of radius = EARTH_RADIUS (Equatorial radius)
  * 
  * @param {object} pointA GeoJSON point
  * @param {object} pointB GeoJSON point
  */
export function haversineDistanceBetween(pointA: GeoJSON.Point, pointB: GeoJSON.Point): Solution {
   const [λ1, φ1] = pointA.coordinates.map(degToRad)
   const [λ2, φ2] = pointB.coordinates.map(degToRad)
   const Δφ = φ2 - φ1
   const Δλ = λ2 - λ1

   const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2)

   return {
      distance: EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)), 
      initialBearing: haversineBearing(λ1, φ1, λ2, φ2),
      finalBearing: (haversineBearing(λ2, φ2, λ1, φ1) + Math.PI) % (2 * Math.PI)
   }
}

function haversineBearing(λ1: number, φ1: number, λ2: number, φ2: number): number {
   const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
   const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
   const θ = Math.atan2(y, x);
   return (θ + 2 * Math.PI) % (2 * Math.PI)
}

/**
 * Shortest distance from point P to the line segment A-B using the Equirectangular projection.
 * Using the method from https://stackoverflow.com/questions/849211/shortest-distance-between-a-point-and-a-line-segment
 * 
 * @param pointP GeoJSON point
 * @param pointA GeoJSON point
 * @param pointB GeoJSON point
 * @returns 
 */
export function distanceToSegment(pointP: GeoJSON.Point, pointA: GeoJSON.Point, pointB: GeoJSON.Point) : Solution {
   const [λ0, φ0] = pointP.coordinates.map(degToRad)
   const [λ1, φ1] = pointA.coordinates.map(degToRad)
   const [λ2, φ2] = pointB.coordinates.map(degToRad)
   
   const x1 = EARTH_RADIUS * (λ1 - λ0) * Math.cos(φ0)
   const y1 = EARTH_RADIUS * (φ1 - φ0)

   const Δx = x1 - EARTH_RADIUS * (λ2 - λ0) * Math.cos(φ0)
   const Δy = y1 - EARTH_RADIUS * (φ2 - φ0)

   const L2 = Δx * Δx + Δy * Δy
   if (L2 == 0) {
      return haversineDistanceBetween(pointP, pointA)
   } else { 
      const t = Math.max(0, Math.min(1, (x1 * Δx + y1 * Δy) / L2))
      return haversineDistanceBetween(pointP, {
         type: 'Point',
         coordinates: [radToDeg(λ1 - t * (λ1 - λ2)), radToDeg(φ1 - t * ( φ1 - φ2))]
      })
   }
}


/** 
 * The code below is a typed Typescript version of the Javascript 
 * [wsg84-util npm package](https://github.com/csbrandt/WGS84Util)
 * 
 * ## License
 * Copyright (c) 2016 Christopher Brandt
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and 
 * associated documentation files (the "Software"), to deal in the Software without restriction, 
 * including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, 
 * subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in all copies or 
 * substantial portions of the Software.
 */

// Semi-Major Axis (Equatorial Radius)
const SEMI_MAJOR_AXIS = 6378137.0;
// Semi-Minor Axis
const SEMI_MINOR_AXIS = 6356752.314245;
// f = 1/298.257223563
const FLATTENING = 0.0033528106647474805;
// First Eccentricity Squared
const ECC_SQUARED = 0.006694380004260827;

/**
 * Calculate the distance between a set of GeoJSON points in meters
 * Uses Vincenty inverse calculation
 * Adapted from http://www.movable-type.co.uk/scripts/latlong-vincenty.html
 *
 * @param {object} pointA GeoJSON point
 * @param {object} pointB GeoJSON point
 * @param {boolean} bearings optional switch for including the bearings in degrees
 * @return {number | object} the distance from this point to the supplied point
 * in meters or an object that includes distance, initial and final bearings (in radians)
 * @throws  {Error}  if formula failed to converge
 */

export function wsg84DistanceBetween (pointA: GeoJSON.Point, pointB: GeoJSON.Point): Solution {
    const L = degToRad(pointB.coordinates[0]) - degToRad(pointA.coordinates[0]);
 
    const tanU1 = (1 - FLATTENING) * Math.tan(degToRad(pointA.coordinates[1])),
       cosU1 = 1 / Math.sqrt((1 + tanU1 * tanU1)),
       sinU1 = tanU1 * cosU1;
    const tanU2 = (1 - FLATTENING) * Math.tan(degToRad(pointB.coordinates[1])),
       cosU2 = 1 / Math.sqrt((1 + tanU2 * tanU2)),
       sinU2 = tanU2 * cosU2;
 
    let iterationLimit = 100, λ = L, lambdaPrime: number, sinλ: number, cosλ: number
    let cosσ: number, σ: number, cosSqAlpha: number, sinσ: number, cos2SigmaM: number
 
    do {
        sinλ = Math.sin(λ)
        cosλ = Math.cos(λ)
        const sinSqSigma = (cosU2 * sinλ) * (cosU2 * sinλ) + (cosU1 * sinU2 - sinU1 * cosU2 * cosλ) * (cosU1 * sinU2 - sinU1 * cosU2 * cosλ);
        sinσ = Math.sqrt(sinSqSigma);
 
       if (sinσ === 0) {
          return { // co-incident points
            "distance": 0,
            "initialBearing": 0,
            "finalBearing": 0
         } 
       }
 
       cosσ = sinU1 * sinU2 + cosU1 * cosU2 * cosλ;
       σ = Math.atan2(sinσ, cosσ);
       const sinα = cosU1 * cosU2 * sinλ / sinσ;
       cosSqAlpha = 1 - sinα * sinα;
       cos2SigmaM = cosσ - 2 * sinU1 * sinU2 / cosSqAlpha;
 
       if (isNaN(cos2SigmaM)) {
          cos2SigmaM = 0; // equatorial line: cosSqAlpha=0 (§6)
       }
 
       var C = FLATTENING / 16 * cosSqAlpha * (4 + FLATTENING * (4 - 3 * cosSqAlpha));
       lambdaPrime = λ;
       λ = L + (1 - C) * FLATTENING * sinα * (σ + C * sinσ * (cos2SigmaM + C * cosσ * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
 
    } while (Math.abs(λ - lambdaPrime) > 1e-12 && --iterationLimit > 0);
 
    if (iterationLimit === 0) {
       throw new Error('Formula failed to converge');
    }
 
    const uSq = cosSqAlpha * (SEMI_MAJOR_AXIS * SEMI_MAJOR_AXIS - SEMI_MINOR_AXIS * SEMI_MINOR_AXIS) / (SEMI_MINOR_AXIS * SEMI_MINOR_AXIS)
    const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
    const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
    const Δσ = B * sinσ * (cos2SigmaM + B / 4 * (cosσ * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
       B / 6 * cos2SigmaM * (-3 + 4 * sinσ * sinσ) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
 
    const s = SEMI_MINOR_AXIS * A * (σ - Δσ)
 
    const α1 = Math.atan2(cosU2 * sinλ, cosU1 * sinU2 - sinU1 * cosU2 * cosλ)
    const α2 = Math.atan2(cosU1 * sinλ, -sinU1 * cosU2 + cosU1 * sinU2 * cosλ)
 
    return {
       "distance": Number(s.toFixed(4)),
       "initialBearing": (α1 + 2 * Math.PI) % (2 * Math.PI),
       "finalBearing": (α2 + 2 * Math.PI) % (2 * Math.PI)
    }
 }