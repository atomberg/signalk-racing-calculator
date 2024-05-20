import { Plugin, PluginServerApp } from '@signalk/server-api';
import { degToRad, radToDeg, distanceToSegment, haversineDistanceBetween, wsg84DistanceBetween } from './distances';
import { Point } from 'geojson';
import * as openapi from './api.json'

let distanceBetween = haversineDistanceBetween

interface SignalKServer extends PluginServerApp {
    debug: (msg: string) => void,
    error: (msg: string) => void,
    registerPutHandler: (
        context: string,
        path: string,
        callback: (context: string, path: string, value: any, callback: () => void) => {
            state: string, statusCode: number, message?: string
        },
        source: string
      ) => void,
    handleMessage: (path: string, values: Object) => void,
    getSelfPath: (path: string) => any
    resourcesApi: {
        setResource: (resource_type: string, resource_id: string, resource_data: object, provider_id?: string) => Promise<void>,
        deleteResource: (resource_type: string, resource_id: string, provider_id?: string) => Promise<void>,
        listResources: (resource_type: string, params: object, provider_id?: string) => Promise<{[key: string]: any}>
    }
}

interface TypedPlugin extends Plugin {
    started: boolean,
    pinEnd?: Point,
    boatEnd?: Point,
    raceStartTimestamp?: number
    raceCourse?: string,
    parsedSettings: ParsedSettings,
    currentRaceLeg: number,
    raceStatus: 'none' | 'pre-start' | 'racing'
    raceBearing?: number
}

interface ParsedSettings {
    distanceToDetectLegCompletion: number,
    fixedMarks: Record<string, Point>,
    raceCourses: Record<string, RaceLeg[]>,
    raceCourseBearings: Record<string, number>
}

interface SignalKValue {
    path: string,
    value: number | string,
    meta?: {
        description: string,
        unit?: string
    }
}

interface RaceLeg {
    waypointMarkName: string,
    waypointMarkPoint: GeoJSON.Point,
    direction: 'upwind' | 'downwind'
}

function pluginConstructor (app: SignalKServer): Plugin {

  const plugin: TypedPlugin = {
    id: 'signalk-racing-calculator',
    name: 'Signal K Racing Calculator',
    
    started: false,
    pinEnd: undefined,
    boatEnd: undefined,
    raceStartTimestamp: undefined,
    parsedSettings: {
        distanceToDetectLegCompletion: 30,
        fixedMarks: {},
        raceCourses: {},
        raceCourseBearings: {}
    },
    raceCourse: undefined,
    currentRaceLeg: 0,
    raceStatus: 'none',
    raceBearing: undefined,

    start: (settings, restartPlugin) => {
        if ('distanceMetric' in settings) {
            switch(settings.distanceMetric) {
                case 'wsg84': 
                    distanceBetween = wsg84DistanceBetween;
                    break;
                default: 
                    distanceBetween = haversineDistanceBetween;
                    break;
            }
        }
        if ('distanceToDetectLegCompletion' in settings) {
            plugin.parsedSettings.distanceToDetectLegCompletion = Number(settings['distanceToDetectLegCompletion'])
        }
        if ('fixedMarks' in settings && Array.isArray(settings.fixedMarks) && settings.fixedMarks.length > 0) {
            for (const mark of settings.fixedMarks) {
                if ('latitude' in mark && 'longitude' in mark && 'markName' in mark) {
                    plugin.parsedSettings.fixedMarks[mark.markName] = {
                        type: 'Point',
                        coordinates: [mark.longitude, mark.latitude]
                    }
                    app.debug(`${mark.markName} @ (${mark.latitude}, ${mark.longitude})`)
                }
            }
        }
        if ('raceCourses' in settings && Array.isArray(settings.raceCourses) && settings.raceCourses.length > 0)  {
            for (const course of settings.raceCourses) {
                if ('courseName' in course && 'courseBearing' in course && 
                    'legs' in course && Array.isArray(course.legs) && course.legs.length > 1) {
                    plugin.parsedSettings.raceCourseBearings[course.courseName] = degToRad(Number(course.courseBearing))
                    plugin.parsedSettings.raceCourses[course.courseName] = course.legs.map((leg: any) => {
                      if ('waypointMark' in leg && leg.waypointMark in plugin.parsedSettings.fixedMarks
                            && 'direction' in leg && (leg.direction === 'upwind' || leg.direction === 'downwind')) {
                        return {
                            waypointMarkName: leg.waypointMark,
                            waypointMarkPoint: plugin.parsedSettings.fixedMarks[leg.waypointMark],
                            direction: leg.direction
                        }
                      }
                    })
                    const msg = plugin
                        .parsedSettings.raceCourses[course.courseName]
                        .map((leg: RaceLeg) => {return leg.waypointMarkName})
                        .join(' > ')
                    const bearing = distanceBetween(
                        plugin.parsedSettings.raceCourses[course.courseName][0].waypointMarkPoint,
                        plugin.parsedSettings.raceCourses[course.courseName][1].waypointMarkPoint
                    ).initialBearing
                    app.debug(`${course.courseName} = ${msg} @ ${radToDeg(bearing)}`)
                }
            }
        }
        plugin.started = true

        function currentPosition(): Point | undefined {
            try {
                const position = app.getSelfPath('navigation.position')
                if (!position.value) return undefined
                else return {
                    type: 'Point',
                    coordinates: [position.value.longitude, position.value.latitude]
                }
            } catch {
                return undefined
            }
        }

        app.registerPutHandler('vessels.self', 'racing.pingBoat', (_c, _p, _v, _cb) => {
            plugin.boatEnd = currentPosition()
            app.debug(`PingBoat @ ${JSON.stringify(plugin.boatEnd)}`)
            if (!plugin.boatEnd) {
                return { state: 'COMPLETED', statusCode: 400 }
            } else {
                return { state: 'SUCCESS', statusCode: 200 }
            }
        }, 'racing.pingBoat');
        app.registerPutHandler('vessels.self', 'racing.pingPin', (_c, _p, _v, _cb) => {
            plugin.pinEnd = currentPosition()
            app.debug(`PingPin @ ${JSON.stringify(plugin.pinEnd)}`)
            if (!plugin.pinEnd) {
                return { state: 'COMPLETED', statusCode: 400 }
            } else {
                return { state: 'SUCCESS', statusCode: 200 }
            }
        }, 'racing.pingPin');
        app.registerPutHandler('vessels.self', 'racing.startRaceCountdown', (_c, _p, value, _cb) => {
            try {
                plugin.raceStartTimestamp = Date.now() + value * 1000
                plugin.raceStatus = 'pre-start'
                app.handleMessage('navigation.racing', {
                    updates: [{
                        values: [{
                            path: 'navigation.racing.raceStatus',
                            value: 'pre-start'
                        }]
                    }]
                })
                app.debug(`SetStartTime @ ${JSON.stringify(new Date(plugin.raceStartTimestamp))}`)
                return { state: 'SUCCESS', statusCode: 200 }
            } catch {
                return { state: 'COMPLETED', statusCode: 400 }
            }
        }, 'racing.startRaceCountdown');
        app.registerPutHandler('vessels.self', 'racing.cancelRace', (_c, _p, _v, _cb) => {
            try {
                plugin.raceStartTimestamp = undefined
                plugin.raceStatus = 'none'
                app.handleMessage('navigation.racing', {
                    updates: [{
                        values: [{
                            path: 'navigation.racing.timeToStart',
                            value: 300
                        },
                        {
                            path: 'navigation.racing.raceStatus',
                            value: 'none'
                        }]
                    }]
                  });
                app.debug(`Race cancelled`)
                return { state: 'SUCCESS', statusCode: 200 }
            } catch {
                return { state: 'COMPLETED', statusCode: 400 }
            }
        }, 'racing.cancelRace');
        app.registerPutHandler('vessels.self', 'racing.selectRaceCourse', (_c, _p, value, _cb) => {
            try {
                if (value in plugin.parsedSettings.raceCourses) {
                    plugin.raceCourse = value
                    plugin.raceBearing = plugin.parsedSettings.raceCourseBearings[value]
                    app.handleMessage('navigation.racing', {
                        updates: [{
                            values: [{
                                path: 'navigation.racing.markName',
                                value: plugin.parsedSettings.raceCourses[value][plugin.currentRaceLeg].waypointMarkName
                            }]
                        }]
                    })
                    app.debug(`Race course selected: ${value}`)
                    return { state: 'SUCCESS', statusCode: 200 }
                } else {
                    return { state: 'COMPLETED', statusCode: 400 }
                }
            } catch {
                return { state: 'COMPLETED', statusCode: 400 }
            }
        }, 'racing.selectRaceCourse');
        app.registerPutHandler('vessels.self', 'racing.nextWaypoint', (_c, _p, _v, _cb) => {
            try {
                if (plugin.raceCourse && plugin.currentRaceLeg + 1 < plugin.raceCourse.length) {
                    plugin.currentRaceLeg += 1
                    app.handleMessage('navigation.racing', {
                        updates: [{
                            values: [{
                                path: 'navigation.racing.markName',
                                value: plugin.parsedSettings.raceCourses[plugin.raceCourse][plugin.currentRaceLeg].waypointMarkName
                            }]
                        }]
                    })
                    return { state: 'SUCCESS', statusCode: 200 }
                }
                return { state: 'COMPLETED', statusCode: 400 }
            } catch {
                return { state: 'COMPLETED', statusCode: 400 }
            }
        }, 'racing.nextWaypoint');

        setInterval(() => {
            const valuesToEmit: SignalKValue[] = []

            if(plugin.raceStartTimestamp !== undefined) {
                const diffMilliseconds = plugin.raceStartTimestamp - Date.now()
                valuesToEmit.push({
                    path: 'navigation.racing.timeToStart',
                    value: diffMilliseconds / 1000
                })

                if (plugin.raceStatus === 'pre-start' && diffMilliseconds < 0) {
                    plugin.raceStatus = 'racing'
                    valuesToEmit.push({
                        path: 'navigation.racing.raceStatus',
                        value: 'racing'
                    })
                }
            }

            const selfPosition = currentPosition()
            const selfCog: number = app.getSelfPath('navigation.courseOverGroundTrue').value
            const selfSog: number = app.getSelfPath('navigation.speedOverGround').value
            
            if(plugin.boatEnd !== undefined && selfPosition !== undefined) {
                valuesToEmit.push({
                    path: 'navigation.racing.distanceBoatEnd',
                    value: distanceBetween(selfPosition, plugin.boatEnd).distance
                })
                if (plugin.pinEnd !== undefined) {
                    valuesToEmit.push({
                        path: 'navigation.racing.distanceStartline',
                        value: distanceToSegment(selfPosition, plugin.boatEnd, plugin.pinEnd).distance
                    })
                }
            }

            if(plugin.pinEnd !== undefined && selfPosition !== undefined) {
                valuesToEmit.push({
                    path: 'navigation.racing.distancePinEnd',
                    value: distanceBetween(selfPosition, plugin.pinEnd).distance
                })
            }

            if (plugin.raceCourse !== undefined) {
                const course = plugin.parsedSettings.raceCourses[plugin.raceCourse][plugin.currentRaceLeg]

                if (selfPosition !== undefined && selfCog !== undefined && selfSog !== undefined) {

                    const selfToMark = distanceBetween(selfPosition, course.waypointMarkPoint)
                    const bearingToMark = (selfToMark.initialBearing - selfCog + 2 * Math.PI) % (2 * Math.PI)
                    
                    valuesToEmit.push({
                        path: 'navigation.racing.distanceToMark',
                        value: selfToMark.distance
                    })
                    valuesToEmit.push({
                        path: 'navigation.racing.cogToMark',
                        value: selfToMark.initialBearing
                    })
                    valuesToEmit.push({
                        path: 'navigation.racing.bearingToMark',
                        value: bearingToMark
                    })
                    valuesToEmit.push({
                        path: 'navigation.racing.vmgToMark',
                        value: selfSog * Math.cos(bearingToMark)
                    })
                    if (plugin.raceBearing !== undefined) {
                        
                        valuesToEmit.push({
                            path: 'navigation.racing.vmg',
                            value: selfSog * Math.cos((plugin.raceBearing - selfCog + 2 * Math.PI) % (2 * Math.PI))
                        })
                    }

                    if (selfToMark.distance < plugin.parsedSettings.distanceToDetectLegCompletion && plugin.currentRaceLeg + 1 < plugin.raceCourse.length) {
                        plugin.currentRaceLeg += 1
                        valuesToEmit.push({
                            path: 'navigation.racing.markName',
                            value: plugin.parsedSettings.raceCourses[plugin.raceCourse][plugin.currentRaceLeg].waypointMarkName  
                        })
                    }
                }
            }
      
            app.handleMessage('navigation.racing', {
              updates: [{
                values: valuesToEmit
              }]
            });
        }, 500)
    },
    stop: () => {
        plugin.started = false
    },
    schema: Object({
        type: 'object',
        required: ['distanceMetric'],
        properties: {
            distanceMetric: {
                type: 'string',
                enum: ['haversine', 'wsg84'],
                title: 'Distance metric to use'
            },
            distanceToDetectLegCompletion: {
                type: 'number',
                title: 'Radius around a mark that will trigger leg completion in meters',
                default: 30
            },
            fixedMarks: {
                title: 'List of fixed marks used to construct race course routes',
                type: 'array',
                items: {
                    title: 'Fixed mark',
                    type: 'object',
                    required: ['latitude', 'longitude', 'markName'],
                    properties: {
                        latitude: {
                            title: "Latitude (in decimal degrees)",
                            type: "number",
                            default: "",
                        },
                        longitude: {
                            title: "Longitude (in decimal degrees)",
                            type: "number",
                            default: "",
                        },
                        markName: {
                            title: "Name of the fixed mark",
                            type: "string",
                            default: "",
                        }
                    }
                },

            },
            raceCourses: {
                title: 'List of race courses around pre-defined fixed marks',
                type: 'array',
                items: {
                    title: 'Race course',
                    type: 'object',
                    required: ['courseName', 'courseBearing', 'legs'],
                    properties: {
                        courseName: {
                            title: 'Name of the race course',
                            type: 'string'
                        },
                        courseBearing: {
                            title: 'Approximate true bearing for the downwind legs of the course (in degrees)',
                            type: 'number'
                        },
                        legs: {
                            title: 'List of legs',
                            type: 'array',
                            items: {
                                title: 'Race leg',
                                type: 'object',
                                required: ['waypointMark', 'direction'],
                                properties: {
                                    waypointMark: {
                                        title: 'Name of the fixed mark serving as the waypoint for this leg',
                                        type: 'string'
                                    },
                                    direction: {
                                        title: 'Upwind or downwind general direction of the leg',
                                        type: 'string',
                                        enum: ['upwind', 'downwind']
                                    }
                                }
                            }
                        }
                    }

                }
            }
        }
      }),
      uiSchema: () => Object({
        distanceMetric: { "ui:widget": "RadioWidget" },
        raceCourses: {
            items: {
                legs: {
                    items: {
                        direction: { "ui:widget": "RadioWidget" }
                    }
                }
            }
        }
      }),
      getOpenApi: () => openapi
  };

  return plugin
}

export = pluginConstructor
