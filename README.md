# SignalK Racing Calculator Plugin

This plugin provides a bare-bones set of racing related delta messages
that can be used for beer can racing around fixed marks. 
All you need is a SignalK server with a GPS receiver that can provide updates for
3 paths:
`navigation.position`,
`navigation.courseOverGroundTrue`, and
`navigation.speedOverGround`.

Based on this information, the following paths wil be computed by this plugin:

| Path                                  | Units     | Module |
| ------------------------------------- | --------- | ------ |
| navigation.racing.timeToStart 	    | s         |  1     |
| navigation.racing.raceStatus 	        | enum      |  1     |
| navigation.racing.distanceBoatEnd 	| m         |  2     |
| navigation.racing.distancePinEnd  	| m         |  2     |
| navigation.racing.distanceStartline 	| m         |  2     |
| navigation.racing.distanceToMark 	    | m         |  3     |
| navigation.racing.bearingToMark       | rad       |  3     |
| navigation.racing.cogToMark 	        | rad       |  3     |
| navigation.racing.vmg 	            | m/s       |  3     |
| navigation.racing.vmgToMark 	        | m/s       |  3     |
| navigation.racing.markName 	        | string    |  3     |
    

### Module 1: Racing timer 

### Module 2: Start line calculator

### Module 3: Race course setup and navigation




