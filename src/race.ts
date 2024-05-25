
export interface Course {
    name: string,
    bearing: number
    legs: CourseLeg[]
}

export interface CourseLeg {
    waypointMarkName: string,
    waypointMarkPoint: GeoJSON.Point,
    direction: 'upwind' | 'downwind'
}

/**
 * Race interface to keep state during a race.
 */
export interface Race {
    course?: Course
    startline: {
        boatEnd?: GeoJSON.Point
        pinEnd?: GeoJSON.Point
    }
    startTimestamp?: number

    status: 'setup' | 'pre-start' | 'racing'
    currentLegIndex: number
}


export class Race implements Race {

    constructor() {
        this.status = 'setup'
        this.startline = {}
        this.currentLegIndex = 0
    }

    get currentLeg() {
        return this.course ? this.course.legs[this.currentLegIndex] : undefined
    }

    nextLeg() {
        if (this.course && this.currentLegIndex + 1 < this.course.legs.length) {
            this.currentLegIndex += 1
            return this.currentLeg
        } else return undefined
    }






}