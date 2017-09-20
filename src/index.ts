// Note: Assumes that AWS authentication will be available.
// Either via an IAM role or environment variables:
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
import * as AWS from "aws-sdk";
import * as _ from "lodash";
import * as colors from "colors/safe";
import {Config} from "./config";
import {Instance} from "aws-sdk/clients/ec2";
import {PutMetricAlarmInput} from "aws-sdk/clients/cloudwatch";

class Main {

    private config : Config;
    private ec2 : AWS.EC2;
    private cloudwatch : AWS.CloudWatch;

    public main() : void {
        this.config = Config.getConfig();
        this.ec2 = new AWS.EC2({region: this.config.region});
        this.cloudwatch = new AWS.CloudWatch({region: this.config.region});

        if(!this.config.notificationArn){
            this.onFatalError("You must specify a notificationArn option for where to receive alerts.", "");
        }

        this.getEc2Info()
            .then(results => {
                const ec2Alarms = this.getEc2AlarmsForInstances(results);
                console.log(ec2Alarms);
            })
            .catch(err => {
                this.onFatalError("Could not list EC2 instances. Error was:", err);
            });
    }

    private getEc2AlarmsForInstances(instances : Instance[]) : PutMetricAlarmInput[] {
        /**
         * StatusCheckFailed > 0
         * CPUUtilization > 95% for 5 minutes
         * NetworkPacketsOut < 100 for 5 minutes
         * Note: You can still run out of disk space on any of your volumes
         */

        const filteredInstances = _.filter(instances, f => f.InstanceId);

        const result = filteredInstances.map(f => {
            const instanceId = f.InstanceId ? f.InstanceId : "";
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
                    Dimensions: [{Name: "InstanceId", Value: instanceId}],
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
                    Dimensions: [{Name: "InstanceId", Value: instanceId}],
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
                    Dimensions: [{Name: "InstanceId", Value: instanceId}],
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

    private onFatalError(msg : string, error : any) : void {
        console.log(colors.red(msg));
        console.log(error);
        process.exit(-1);
    }
}

(new Main()).main();