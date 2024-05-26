import { Plugin, PluginServerApp } from '@signalk/server-api';
import { Race, Course } from './race';
import { degToRad, distanceToSegment, haversineDistanceBetween, wsg84DistanceBetween, Solution } from './distances';
import { Point } from 'geojson';
import * as openapi from './api.json'

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
}

interface TypedPlugin extends Plugin {
    started: boolean,
    distBtw: (x: Point, y: Point) => Solution,
    updateFreq: number,
    distanceToDetectLegCompletion: number,
    raceCourses: Record<string, Course>
    race: Race
}

interface SignalKValue {
    path: string,
    value: number | string,
    meta?: {
        description: string,
        unit?: string
    }
}

function pluginConstructor(app: SignalKServer): Plugin {

    const plugin: TypedPlugin = {
        id: 'signalk-racing-calculator',
        name: 'Signal K Racing Calculator',

        started: false,
        updateFreq: 500,
        distBtw: haversineDistanceBetween,
        distanceToDetectLegCompletion: 30,
        raceCourses: {},
        race: new Race(),

        start: (settings, restartPlugin) => {
            if ('distanceMetric' in settings) {
                switch (settings.distanceMetric) {
                    case 'wsg84':
                        plugin.distBtw = wsg84DistanceBetween;
                        break;
                    default:
                        plugin.distBtw = haversineDistanceBetween;
                        break;
                }
            }
            if ('distanceToDetectLegCompletion' in settings) {
                plugin.distanceToDetectLegCompletion = Number(settings['distanceToDetectLegCompletion'])
            }
            const fixedMarks: Record<string, Point> = {}
            if ('fixedMarks' in settings && Array.isArray(settings.fixedMarks) && settings.fixedMarks.length > 0) {
                for (const mark of settings.fixedMarks) {
                    if ('latitude' in mark && 'longitude' in mark && 'markName' in mark) {
                        fixedMarks[mark.markName] = {
                            type: 'Point',
                            coordinates: [mark.longitude, mark.latitude]
                        }
                        app.debug(`${mark.markName} @ (${mark.latitude}, ${mark.longitude})`)
                    }
                }
            }
            if ('raceCourses' in settings && Array.isArray(settings.raceCourses) && settings.raceCourses.length > 0) {
                for (const course of settings.raceCourses) {
                    if ('courseName' in course && 'courseBearing' in course &&
                        'legs' in course && Array.isArray(course.legs) && course.legs.length > 1) {
                        plugin.raceCourses[course.courseName] = {
                            name: course.courseName,
                            bearing: degToRad(Number(course.courseBearing)),
                            legs: course.legs.map((leg: any) => {
                                if ('waypointMark' in leg && leg.waypointMark in fixedMarks
                                    && 'direction' in leg && (leg.direction === 'upwind' || leg.direction === 'downwind')) {
                                    return {
                                        waypointMarkName: leg.waypointMark,
                                        waypointMarkPoint: fixedMarks[leg.waypointMark],
                                        direction: leg.direction
                                    }
                                }
                            })
                        }
                        app.debug(`${course.courseName} = ${plugin.raceCourses[course.courseName].legs.map((leg) => leg.waypointMarkName).join(' > ')}`)
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

            app.registerPutHandler('vessels.self', 'racing.startCountdown', (_c, _p, value, _cb) => {
                try {
                    plugin.race.startTimestamp = Date.now() + value * 1000
                    plugin.race.status = 'pre-start'
                    plugin.race.currentLegIndex = 0
                    const values = [{
                        path: 'navigation.racing.raceStatus',
                        value: String(plugin.race.status)
                    }]

                    const leg = plugin.race.currentLeg
                    if (leg) values.push({
                        path: 'navigation.racing.markName',
                        value: leg.waypointMarkName
                    })
                    app.handleMessage('navigation.racing', { updates: [{ values }] })

                    app.debug(`SetStartTime @ ${JSON.stringify(new Date(plugin.race.startTimestamp))}`)
                    return { state: 'SUCCESS', statusCode: 200 }
                } catch {
                    return { state: 'COMPLETED', statusCode: 400 }
                }
            }, 'racing.startCountdown');
            app.registerPutHandler('vessels.self', 'racing.cancelRace', (_c, _p, _v, _cb) => {
                try {
                    plugin.race.startTimestamp = undefined
                    plugin.race.status = 'setup'
                    plugin.race.currentLegIndex = 0
                    const values = [{
                        path: 'navigation.racing.timeToStart',
                        value: 300
                    }, {
                        path: 'navigation.racing.raceStatus',
                        value: String(plugin.race.status)
                    }]

                    const leg = plugin.race.currentLeg
                    if (leg) values.push({
                        path: 'navigation.racing.markName',
                        value: leg.waypointMarkName
                    })
                    app.handleMessage('navigation.racing', { updates: [{ values }] })
                    app.debug(`Race cancelled`)
                    return { state: 'SUCCESS', statusCode: 200 }
                } catch {
                    return { state: 'COMPLETED', statusCode: 400 }
                }
            }, 'racing.cancelRace');
            app.registerPutHandler('vessels.self', 'racing.pingBoat', (_c, _p, _v, _cb) => {
                plugin.race.startline.boatEnd = currentPosition()
                app.debug(`PingBoat @ ${JSON.stringify(plugin.race.startline.boatEnd)}`)
                if (!plugin.race.startline.boatEnd) {
                    return { state: 'COMPLETED', statusCode: 400 }
                } else {
                    return { state: 'SUCCESS', statusCode: 200 }
                }
            }, 'racing.pingBoat');
            app.registerPutHandler('vessels.self', 'racing.pingPin', (_c, _p, _v, _cb) => {
                plugin.race.startline.pinEnd = currentPosition()
                app.debug(`PingPin @ ${JSON.stringify(plugin.race.startline.pinEnd)}`)
                if (!plugin.race.startline.pinEnd) {
                    return { state: 'COMPLETED', statusCode: 400 }
                } else {
                    return { state: 'SUCCESS', statusCode: 200 }
                }
            }, 'racing.pingPin');

            app.registerPutHandler('vessels.self', 'racing.selectRaceCourse', (_c, _p, value, _cb) => {
                try {
                    if (value in plugin.raceCourses && plugin.race.status !== 'racing') {
                        plugin.race.course = plugin.raceCourses[value]
                        plugin.race.currentLegIndex = 0
                        app.handleMessage('navigation.racing', {
                            updates: [{
                                values: [{
                                    path: 'navigation.racing.markName',
                                    value: plugin.race.course.legs[plugin.race.currentLegIndex].waypointMarkName
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
                    const nextLeg = plugin.race.nextLeg()
                    if (nextLeg) {
                        app.handleMessage('navigation.racing', {
                            updates: [{
                                values: [{
                                    path: 'navigation.racing.markName',
                                    value: nextLeg.waypointMarkName
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

                if (plugin.race.startTimestamp !== undefined) {
                    const diffMilliseconds = plugin.race.startTimestamp - Date.now()
                    valuesToEmit.push({
                        path: 'navigation.racing.timeToStart',
                        value: diffMilliseconds / 1000
                    })

                    if (plugin.race.status === 'pre-start' && diffMilliseconds < 0) {
                        plugin.race.status = 'racing'
                        valuesToEmit.push({
                            path: 'navigation.racing.raceStatus',
                            value: 'racing'
                        })
                    }
                }

                const selfPosition = currentPosition()
                const selfCog: number = app.getSelfPath('navigation.courseOverGroundTrue').value
                const selfSog: number = app.getSelfPath('navigation.speedOverGround').value

                if (plugin.race.startline.boatEnd && selfPosition) {
                    valuesToEmit.push({
                        path: 'navigation.racing.distanceBoatEnd',
                        value: plugin.distBtw(selfPosition, plugin.race.startline.boatEnd).distance
                    })
                    if (plugin.race.startline.pinEnd) {
                        valuesToEmit.push({
                            path: 'navigation.racing.distanceStartline',
                            value: distanceToSegment(
                                selfPosition, plugin.race.startline.boatEnd, plugin.race.startline.pinEnd
                            ).distance
                        })
                    }
                }

                if (plugin.race.startline.pinEnd && selfPosition) {
                    valuesToEmit.push({
                        path: 'navigation.racing.distancePinEnd',
                        value: plugin.distBtw(selfPosition, plugin.race.startline.pinEnd).distance
                    })
                }

                if (plugin.race.course && plugin.race.currentLeg) {
                    const leg = plugin.race.currentLeg

                    if (selfPosition && selfCog && selfSog) {

                        const selfToMark = plugin.distBtw(selfPosition, leg.waypointMarkPoint)
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
                        valuesToEmit.push({
                            path: 'navigation.racing.vmg',
                            value: selfSog * Math.cos((plugin.race.course.bearing - selfCog + 2 * Math.PI) % (2 * Math.PI))
                        })

                        if (selfToMark.distance < plugin.distanceToDetectLegCompletion) {
                            const nextLeg = plugin.race.nextLeg()
                            if (nextLeg) {
                                valuesToEmit.push({
                                    path: 'navigation.racing.markName',
                                    value: nextLeg.waypointMarkName
                                })
                            }
                        }
                    }
                }

                app.handleMessage('navigation.racing', {
                    updates: [{
                        values: valuesToEmit
                    }]
                });
            }, plugin.updateFreq)

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
