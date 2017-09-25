import * as AWS from "aws-sdk";

export interface LoadBalancerWithStatistics {
    instance : AWS.ELBv2.LoadBalancer;
    TargetResponseTimes: number[];
    RequestCountCounts: number[];
}