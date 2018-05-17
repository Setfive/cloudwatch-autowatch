"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class CloudWatchAlarmSet {
}
exports.CloudWatchAlarmSet = CloudWatchAlarmSet;
class SavedAlarm {
    constructor(id, alarms) {
        this.taggableIdOrArn = id;
        this.alarms = alarms;
    }
    static getAvailableServices() {
        return ["EC2", "RDS", "ELB", "Redshift"];
    }
}
exports.SavedAlarm = SavedAlarm;
