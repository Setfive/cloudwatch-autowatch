// Note: Assumes that AWS authentication will be available.
// Either via an IAM role or environment variables:
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
import * as AWS from "aws-sdk";
import * as _ from "lodash";
import * as colors from "colors/safe";
import * as Bluebird from "bluebird";
import {Config} from "./config";
import {Instance} from "aws-sdk/clients/ec2";
import {PutMetricAlarmInput} from "aws-sdk/clients/cloudwatch";

class Main {

    private config : Config;
    private ec2 : AWS.EC2;
    private rds : AWS.RDS;
    private cloudwatch : AWS.CloudWatch;

    public main() : void {
        this.config = Config.getConfig();

        this.ec2 = new AWS.EC2({region: this.config.region});
        this.rds = new AWS.RDS({region: this.config.region});
        this.cloudwatch = new AWS.CloudWatch({region: this.config.region});

        if(!this.config.notificationArn){
            this.onFatalError("You must specify a notificationArn option for where to receive alerts.", "");
        }

        this.getRdsInfo()
            .then(results => {
                const alarms = this.getRdsAlarmsForInstances(results);
                console.log(alarms);
            })
            .catch(err => {
                this.onFatalError("Could not list RDS instances. Error was:", err);
            });

        /*
        this.getEc2Info()
            .then(results => {
                const ec2Alarms = this.getEc2AlarmsForInstances(results);
                console.log(ec2Alarms);
            })
            .catch(err => {
                this.onFatalError("Could not list EC2 instances. Error was:", err);
            });
        */
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

    private onFatalError(msg : string, error : any) : void {
        console.log(colors.red(msg));
        console.log(error);
        process.exit(-1);
    }
}

(new Main()).main();