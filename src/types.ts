import * as AWS from "aws-sdk";

export interface LoadBalancerWithStatistics {
    instance : AWS.ELBv2.LoadBalancer;
    TargetResponseTimes: number[];
    RequestCountCounts: number[];
}

export type CloudWatchTag = Tag[];

interface Tag {
    Key : string;
    Value : string;
}

export type CloudWatchAlarmSetServices = keyof CloudWatchAlarmSet;

export class CloudWatchAlarmSet {
    EC2 : SavedAlarm[];
    RDS : SavedAlarm[];
    ELB : SavedAlarm[];
}

export class SavedAlarm {
    readonly taggableIdOrArn : string;
    readonly alarms : AWS.CloudWatch.PutMetricAlarmInput[];

    constructor(id : string, alarms : AWS.CloudWatch.PutMetricAlarmInput[]) {
        this.taggableIdOrArn = id;
        this.alarms = alarms;
    }

    public static getAvailableServices() : CloudWatchAlarmSetServices[] {
        return ["EC2", "RDS", "ELB"];
    }
}