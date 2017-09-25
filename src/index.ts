// Note: Assumes that AWS authentication will be available.
// Either via an IAM role or environment variables:
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
import * as AWS from "aws-sdk";
import * as _ from "lodash";
import * as colors from "colors/safe";
import * as Bluebird from "bluebird";
import * as moment from "moment";
import {Config} from "./config";
import {Instance} from "aws-sdk/clients/ec2";
import {PutMetricAlarmInput} from "aws-sdk/clients/cloudwatch";
import {LoadBalancerWithStatistics} from "./types";

class Main {

    private config : Config;
    private ec2 : AWS.EC2;
    private rds : AWS.RDS;
    private elb : AWS.ELBv2;
    private cloudwatch : AWS.CloudWatch;

    public main() : void {
        this.config = Config.getConfig();

        this.ec2 = new AWS.EC2({region: this.config.region});
        this.rds = new AWS.RDS({region: this.config.region});
        this.elb = new AWS.ELBv2({region: this.config.region});
        this.cloudwatch = new AWS.CloudWatch({region: this.config.region});

        if(!this.config.notificationArn){
            this.onFatalError("You must specify a notificationArn option for where to receive alerts.", "");
        }

        Bluebird.each(["EC2", "RDS", "ELB"], f => {
           switch(f){
               case "EC2":
                   return this.handleEc2();
               case "RDS":
                   return this.handleRds();
               case "ELB":
                   return this.handleELB();
               default: throw "Unimplemented service: " + f;
           }
        })
        .catch(err => {
            this.onFatalError("Error processing alarms.", err);
        })

        /*
        this.getELBInfo().then(results => {
            const alarms = this.getELBAlarmsForInstances(results);
            console.log(alarms);
        })
        .catch(err => {
            this.onFatalError("Could not list ELB instances. Error was:", err);
        });


        this.getRdsInfo()
            .then(results => {
                const alarms = this.getRdsAlarmsForInstances(results);
                console.log(alarms);
            })
            .catch(err => {
                this.onFatalError("Could not list RDS instances. Error was:", err);
            });

        */
    }

    private handleELB() : Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            resolve(true);
        });
    }

    private handleRds() : Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            resolve(true);
        });
    }

    private handleEc2(): Promise<boolean> {

        return new Promise<boolean>((resolve, reject) => {
            this.getEc2Info()
                .then(results => {
                    const ec2Alarms = this.getEc2AlarmsForInstances(results);
                    const instanceIds = results.map(f => <string> f.InstanceId);
                    const tagParams = {Resources: instanceIds, Tags: [{Key: "SetfiveCloudAutoWatch", Value: moment().toISOString()}]};

                    /*
                    this.applyCloudWatchAlarms(ec2Alarms)
                        .then(() => {
                        this.ec2.createTags(tagParams, (err, result) => {
                            if(err){
                                return reject(err);
                            }

                            resolve(true);
                        });
                    })
                    .catch(err => {
                        reject(err);
                    });
                    */
                    
                })
                .catch(err => {
                    reject(err);
                });
        });

    }

    private applyCloudWatchAlarms(alarms : PutMetricAlarmInput[]) : Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            Bluebird.each(alarms, alarm => {
                return new Promise<boolean>((resolveAlarm, rejectAlarm) => {
                    this.cloudwatch.putMetricAlarm(alarm, (err, result) => {
                        if(err){
                            return rejectAlarm(err);
                        }
                        resolveAlarm(true);
                    });
                });
            })
            .then(results => resolve(true))
            .catch(err => reject(err));
        });
    }

    private getEc2AlarmsForInstances(instances : Instance[]) : PutMetricAlarmInput[] {
        /**
         * StatusCheckFailed > 0
         * CPUUtilization > 95% for 5 minutes
         * NetworkPacketsOut < 100 for 5 minutes
         * Note: You can still run out of disk space on any of your volumes
         */

        const result = instances.map(f => {

            if(!f.InstanceId){
                throw "Null instanceId on EC2?";
            }

            return [
                {
                    ActionsEnabled: true,
                    AlarmName: "SetfiveCloudAutoWatch: Status check failed",
                    ComparisonOperator: "GreaterThanThreshold",
                    MetricName: "StatusCheckFailed",
                    Namespace: "AWS/EC2",
                    Period: 60,
                    EvaluationPeriods: 1,
                    Threshold: 0,
                    Statistic: "Maximum",
                    Dimensions: [{Name: "InstanceId", Value: f.InstanceId}],
                    AlarmActions: [this.config.notificationArn]
                },
                {
                    ActionsEnabled: true,
                    AlarmName: "SetfiveCloudAutoWatch: CPU utilization over 95%",
                    ComparisonOperator: "GreaterThanThreshold",
                    MetricName: "CPUUtilization",
                    Namespace: "AWS/EC2",
                    Period: 60,
                    EvaluationPeriods: 5,
                    Threshold: 95,
                    Statistic: "Average",
                    Dimensions: [{Name: "InstanceId", Value: f.InstanceId}],
                    AlarmActions: [this.config.notificationArn]
                },
                {
                    ActionsEnabled: true,
                    AlarmName: "SetfiveCloudAutoWatch: Network I/O low",
                    ComparisonOperator: "LessThanThreshold",
                    MetricName: "NetworkPacketsOut",
                    Namespace: "AWS/EC2",
                    Period: 60,
                    EvaluationPeriods: 5,
                    Threshold: 100,
                    Statistic: "Average",
                    Dimensions: [{Name: "InstanceId", Value: f.InstanceId}],
                    AlarmActions: [this.config.notificationArn]
                }
            ]
        });

        return _.flatten(result);
    }

    private getEc2Info() : Promise<Instance[]> {
        return new Promise<Instance[]>((resolve, reject) => {
            this.ec2.describeInstances((err, data) => {
                if(err){
                    return reject(err);
                }

                if(!data || !data.Reservations){
                    return resolve([]);
                }

                const instances = _.flatten(data.Reservations.map(f => f.Instances ? f.Instances : []));
                const result : Instance[] = _.reject(instances, f => {
                   return _.find(f.Tags, f => f.Key == "SetfiveCloudAutoWatch" && f.Value);
                });

                resolve(result);
            });
        });
    }

    private getRdsAlarmsForInstances(instances : AWS.RDS.DBInstance[]) : PutMetricAlarmInput[] {
        /*
        * CPUUtilization > 95% for 5 minute
        * FreeStorageSpace < 1gb for 5 minute
        * DiskQueueDepth > 100 for 5 minutes
        */

        const result = instances.map(f => {

            if(!f.DBInstanceIdentifier){
                throw "Null identifier on RDS?";
            }

            return [
                {
                    ActionsEnabled: true,
                    AlarmName: "SetfiveCloudAutoWatch: CPU utilization over 95%",
                    ComparisonOperator: "GreaterThanThreshold",
                    MetricName: "CPUUtilization",
                    Namespace: "AWS/RDS",
                    Period: 60,
                    EvaluationPeriods: 5,
                    Threshold: 95,
                    Statistic: "Average",
                    Dimensions: [{Name: "DBInstanceIdentifier", Value: f.DBInstanceIdentifier}],
                    AlarmActions: [this.config.notificationArn]
                },
                {
                    ActionsEnabled: true,
                    AlarmName: "SetfiveCloudAutoWatch: Storage space less than 1GB",
                    ComparisonOperator: "LessThanThreshold",
                    MetricName: "FreeStorageSpace",
                    Namespace: "AWS/RDS",
                    Period: 60,
                    EvaluationPeriods: 5,
                    Threshold: 1073741824,
                    Statistic: "Average",
                    Dimensions: [{Name: "DBInstanceIdentifier", Value: f.DBInstanceIdentifier}],
                    AlarmActions: [this.config.notificationArn]
                },
                {
                    ActionsEnabled: true,
                    AlarmName: "SetfiveCloudAutoWatch: Query depth over 100",
                    ComparisonOperator: "GreaterThanThreshold",
                    MetricName: "DiskQueueDepth",
                    Namespace: "AWS/RDS",
                    Period: 60,
                    EvaluationPeriods: 5,
                    Threshold: 100,
                    Statistic: "Average",
                    Dimensions: [{Name: "DBInstanceIdentifier", Value: f.DBInstanceIdentifier}],
                    AlarmActions: [this.config.notificationArn]
                },
            ]
        });

        return _.flatten(result);
    }

    private getTagsForRDSInstances(instances : AWS.RDS.DBInstance[]) : Promise<AWS.RDS.TagList[]> {

        return new Promise<AWS.RDS.TagList[]>((resolve, reject) => {
            Bluebird.map(instances, (item) => {
                return new Promise<AWS.RDS.TagList>((resolveInstance, rejectInstance) => {
                    if (!item.DBInstanceArn) {
                        throw "RDS missing instance ARN?";
                    }

                    this.rds.listTagsForResource({ResourceName: item.DBInstanceArn}, (err, rdsData) => {
                        if(err){
                            return rejectInstance(err);
                        }

                        const res = rdsData.TagList ? rdsData.TagList : [];
                        resolveInstance(res);
                    });
                });
            }, {concurrency: 2})
            .then(results => {
                resolve(results);
            })
            .catch((err) => {
                reject(err);
            });
        });

    }

    private getRdsInfo() : Promise<AWS.RDS.DBInstance[]> {

        return new Promise<AWS.RDS.DBInstance[]>((resolve, reject) => {
            this.rds.describeDBInstances((err, data) => {
               if(err){
                   return reject(err);
               }

               if(!data.DBInstances) {
                   return resolve([]);
               }

               this.getTagsForRDSInstances(data.DBInstances)
                   .then(tagResult => {
                       const instancesAndTags = _.map(data.DBInstances, (item, index) => {
                          return {Instance: item, Tags: tagResult[index]};
                       });

                       const instances = _.reject(instancesAndTags, f => {
                           return _.find(f.Tags, fx => fx.Key == "SetfiveCloudAutoWatch" && fx.Value);
                       });

                       resolve(instances.map(f => f.Instance));
                   })
                   .catch(err => reject(err));

            });
        });

    }

    private getTagsForELBInstances(instances : AWS.ELBv2.LoadBalancer[]) : Promise<AWS.ELBv2.TagDescription[]> {

        const chunkedArns = _.chunk(instances.map(f => f.LoadBalancerArn), 20);

        return new Promise<AWS.ELBv2.TagDescription[]>((resolve, reject) => {
            Bluebird.map(chunkedArns, (instanceArns) => {
                return new Promise<AWS.ELBv2.TagDescription[]>((resolveInstance, rejectInstance) => {

                    this.elb.describeTags({ResourceArns: <string[]> instanceArns}, (err, elbData) => {
                        if (err) {
                            return rejectInstance(err);
                        }

                        resolveInstance(elbData.TagDescriptions);
                    });
                });
            }, {concurrency: 2})
            .then(results => {
                resolve(_.flatten(results));
            })
            .catch((err) => {
                reject(err);
            });
        });

    }

    private getELBAlarmsForInstances(instances : LoadBalancerWithStatistics[]) : PutMetricAlarmInput[] {
        /**
         * HTTPCode_Target_5XX_Count > 0 for 5 minutes
         * TargetResponseTime > [max last 24 hrs] for 5 minutes
         * RequestCount > [max last 24 hrs]
         */

        const result = instances.map(f => {
            if(!f.instance.LoadBalancerArn){
                throw "Missing ARN on loadbalancer?";
            }

            const arn = f.instance.LoadBalancerArn.split(":").pop();
            if(!arn){
                throw "Missing name from ARN?";
            }

            const cloudwatchDimension = arn.replace("loadbalancer/", "");

            const alarms = [
                {ActionsEnabled: true,
                 AlarmName: "SetfiveCloudAutoWatch: 500s over 0 for 5 minutes",
                 ComparisonOperator: "GreaterThanThreshold",
                 MetricName: "HTTPCode_Target_5XX_Count",
                 Namespace: "AWS/ApplicationELB",
                 Period: 60,
                 EvaluationPeriods: 5,
                 Threshold: 0,
                 Statistic: "Average",
                 Dimensions: [{Name: "LoadBalancer", Value: cloudwatchDimension}],
                 AlarmActions: [this.config.notificationArn]
            },];

            const maxResponse = _.max(f.TargetResponseTimes);
            if(maxResponse) {
                alarms.push({
                        ActionsEnabled: true,
                        AlarmName: "SetfiveCloudAutoWatch: Response time over 200% of 24hr max for 5 minutes",
                        ComparisonOperator: "GreaterThanThreshold",
                        MetricName: "TargetResponseTime",
                        Namespace: "AWS/ApplicationELB",
                        Period: 60,
                        EvaluationPeriods: 5,
                        Threshold: maxResponse * 2,
                        Statistic: "Average",
                        Dimensions: [{Name: "LoadBalancer", Value: cloudwatchDimension}],
                        AlarmActions: [this.config.notificationArn]
                });
            }

            const maxRequest = _.max(f.RequestCountCounts);
            if(maxRequest) {
                alarms.push({
                        ActionsEnabled: true,
                        AlarmName: "SetfiveCloudAutoWatch: Requests over 200% of 24hr max for 5 minutes",
                        ComparisonOperator: "GreaterThanThreshold",
                        MetricName: "TargetResponseTime",
                        Namespace: "AWS/ApplicationELB",
                        Period: 60,
                        EvaluationPeriods: 5,
                        Threshold: maxRequest * 2,
                        Statistic: "Sum",
                        Dimensions: [{Name: "LoadBalancer", Value: cloudwatchDimension}],
                        AlarmActions: [this.config.notificationArn]
                });
            }

            return alarms;
        });

        return _.flatten(result);
    }

    private getELBStatisticsForLoadbalancers(instances : AWS.ELBv2.LoadBalancer[]) : Promise<LoadBalancerWithStatistics[]> {

        const startTime = moment().subtract("24", "hours").toDate();
        const endTime = moment().toDate();

        return new Promise<LoadBalancerWithStatistics[]>((resolve, reject) => {

            Bluebird.map(instances, (instance) => {

                if(!instance.LoadBalancerArn){
                    throw "Missing ARN on load balancer?";
                }

                const arn = instance.LoadBalancerArn.split(":").pop();
                if(!arn){
                    throw "Missing name from ARN?";
                }

                const cloudwatchDimension = arn.replace("loadbalancer/", "");

                const targetTime = new Promise<AWS.CloudWatch.Datapoint[]>((resolveInstance, rejectInstance) => {
                    const params = {"Namespace": "AWS/ApplicationELB",
                                    "MetricName": "TargetResponseTime",
                                    "StartTime": startTime,
                                    "EndTime": endTime,
                                    "Period": 60,
                                    "Statistics": ["Maximum"],
                                    "Dimensions": [{"Name": "LoadBalancer", "Value": cloudwatchDimension}]
                    };

                    this.cloudwatch.getMetricStatistics(params, (err, response) => {
                        if(err){
                            return rejectInstance(err);
                        }

                        resolveInstance(response.Datapoints);
                    });
                });

                const responseCount = new Promise<AWS.CloudWatch.Datapoint[]>((resolveInstance, rejectInstance) => {
                    const params = {
                        "Namespace": "AWS/ApplicationELB",
                        "MetricName": "RequestCount",
                        "StartTime": startTime,
                        "EndTime": endTime,
                        "Period": 60,
                        "Statistics": ["Sum"],
                        "Dimensions": [{"Name": "LoadBalancer", "Value": cloudwatchDimension}]
                    };

                    this.cloudwatch.getMetricStatistics(params, (err, response) => {
                        if (err) {
                            return rejectInstance(err);
                        }

                        resolveInstance(response.Datapoints);
                    });
                });

                return Bluebird.all([targetTime, responseCount])
                               .then(results => {
                                   return {instance: instance,
                                           TargetResponseTimes: results[0].map(f => f.Maximum),
                                           RequestCountCounts: results[1].map(f => f.Sum)};
                               });

            }, {concurrency: 2})
            .then(results => {
                resolve(<LoadBalancerWithStatistics[]> results);
            })
            .catch((err) => {
                reject(err);
            });

        });
    }

    private getELBInfo() : Promise<LoadBalancerWithStatistics[]> {

        return new Promise<LoadBalancerWithStatistics[]>((resolve, reject) => {
            this.elb.describeLoadBalancers((err, data) => {

                if(err){
                    return reject(err);
                }

                if(!data.LoadBalancers || data.LoadBalancers.length == 0){
                    return resolve([]);
                }

                this.getTagsForELBInstances(data.LoadBalancers)
                    .then(tagData => {
                        const targetInstances = _.reject(data.LoadBalancers, f => {
                            const lbTags = _.find(tagData, td => td.ResourceArn == f.LoadBalancerArn);
                            if(!lbTags){
                                return false;
                            }

                            return _.find(lbTags.Tags, fx => fx.Key == "SetfiveCloudAutoWatch" && fx.Value);
                        });

                        this.getELBStatisticsForLoadbalancers(targetInstances)
                            .then(instanceWithStats => {
                                resolve(instanceWithStats);
                            })
                            .catch((err) => reject(err));

                    })
                    .catch((err) => reject(err));
            });
        });

    }

    private onFatalError(msg : string, error : any) : void {
        console.log(colors.red(msg));
        console.log(error);
        process.exit(-1);
    }
}

(new Main()).main();