// Note: Assumes that AWS authentication will be available.
// Either via an IAM role or environment variables:
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
import * as AWS from "aws-sdk";
import * as _ from "lodash";
import * as colors from "colors/safe";
import * as Bluebird from "bluebird";
import * as moment from "moment";
import * as fs from "fs";
import {Config} from "./config";
import {Instance} from "aws-sdk/clients/ec2";
import {PutMetricAlarmInput} from "aws-sdk/clients/cloudwatch";
import {CloudWatchTag, SavedAlarm, LoadBalancerWithStatistics, CloudWatchAlarmSet} from "./types";

process.stdin.resume();
process.stdin.setEncoding('utf8');

class Main {

    private config : Config;
    private accountId : string;

    private ec2 : AWS.EC2;
    private rds : AWS.RDS;
    private elb : AWS.ELBv2;
    private sns : AWS.SNS;
    private redshift : AWS.Redshift;
    private cloudwatch : AWS.CloudWatch;

    public main() : void {
        this.config = Config.getConfig();

        this.ec2 = new AWS.EC2({region: this.config.region});
        this.rds = new AWS.RDS({region: this.config.region});
        this.elb = new AWS.ELBv2({region: this.config.region});
        this.sns = new AWS.SNS({region: this.config.region});
        this.redshift = new AWS.Redshift({region: this.config.region});
        this.cloudwatch = new AWS.CloudWatch({region: this.config.region});

        if (this.config.action == "help" || this.config.action == "") {
            return Config.outputHelp();
        } else if (this.config.action == "generateAlarms") {
            if (!this.config.notificationArn || this.config.notificationArn.length == 0) {
                this.onFatalError("You must specify a notificationArn option for where to receive alerts.", "");
            }

            const sts = new AWS.STS({region: this.config.region});

            sts.getCallerIdentity({}, (err, response) => {
               if(err || !response.Account){
                   return this.onFatalError("Could not get user info from STS.", err);
               }

               this.accountId = response.Account;
               this.log("AWS Account ID: " + this.accountId);

               this.generateAlarms()
                   .then((savedAlarms) => {
                       if(this.config.addImmediately){
                           this.log("Applying immediately as requested.");
                           this.processSavedAlarms(savedAlarms);
                       }else {
                           process.exit(0);
                       }
                   })
                   .catch(() => {
                       process.exit(-1);
                   });
            });

        } else if (this.config.action == "addAlarmsFromFile") {
            if (!this.config.input || this.config.input.length == 0) {
                this.onFatalError("You must specify an input JSON file to add alerts.", "");
            }

            try {
                const savedAlarms = <CloudWatchAlarmSet> JSON.parse(fs.readFileSync(this.config.input, "utf8"));
                if (!savedAlarms) {
                    this.onFatalError("Could not parse " + this.config.input, null);
                }

                return this.processSavedAlarms(savedAlarms);
            } catch (e) {
                this.onFatalError(e, null);
            }
        } else if (this.config.action == "listSnsTopics") {

            this.sns.listTopics((err, results) => {
                if(err){
                    return this.onFatalError("Could not list SNS topics", err);
                }

                this.log("Available SNS Topics:");
                if(results.Topics) {
                    results.Topics.forEach(f => {
                        const arn = f.TopicArn ? f.TopicArn : "No ARN";
                        this.log(arn);
                    });
                }

                process.exit(0);
            });

        } else {
            this.onFatalError("Unrecognized action: " + this.config.action, "");
        }

    }

    private generateAlarms() : Promise<CloudWatchAlarmSet> {
        return new Promise<CloudWatchAlarmSet>((resolve, reject) => {
            Bluebird.mapSeries(SavedAlarm.getAvailableServices(), f => {
                switch (f) {
                    case "EC2":
                        return this.getEc2Alarms();
                    case "RDS":
                        return this.getRdsAlarms();
                    case "ELB":
                        return this.getELBAlarms();
                    case "Redshift":
                        return this.getRedshiftAlarms();
                    default:
                        throw "Unimplemented service: " + f;
                }
            })
            .then((results) => {
                const savedAlarms: CloudWatchAlarmSet = {
                    EC2: results[0],
                    RDS: results[1],
                    ELB: results[2],
                    Redshift: results[3]
                };

                if(!this.config.addImmediately) {
                    fs.writeFileSync(this.config.output, JSON.stringify(savedAlarms, null, 2));
                    this.log("Writing proposed alarms to alarms.json. Run with '--input=alarms.json' to add them.");
                }

                resolve(savedAlarms);
            })
            .catch(err => {
                this.onFatalError("Error generating alarms.", err);
                reject(err);
            });
        });
    }

    private processSavedAlarms(savedAlarms: CloudWatchAlarmSet): void {

        Bluebird.each(SavedAlarm.getAvailableServices(), f => {
            return new Promise<boolean>((resolve, reject) => {
                const taggableIdOrArns = savedAlarms[f].map(e => e.taggableIdOrArn);
                const alarms = _.flatten(savedAlarms[f].map(e => e.alarms));

                if (taggableIdOrArns.length == 0 || alarms.length == 0) {
                    this.log("No " + f + " alarms found. Skipping");
                    return resolve(true);
                }

                this.log("Applying " + f + " alarms and tags on: " + taggableIdOrArns.join(", "));

                if(f == "EC2"){
                    const tagParams = {Resources: taggableIdOrArns, Tags: this.getCloudWatchTag()};
                    this.applyCloudWatchAlarms(alarms)
                        .then(() => {
                            this.ec2.createTags(tagParams, (err, result) => {
                                if (err) {
                                    return reject(err);
                                }
                                resolve(true);
                            });
                        })
                        .catch(err => {
                            reject(err);
                        });
                }else if(f == "RDS"){
                    this.applyCloudWatchAlarms(alarms)
                        .then(() => {
                            Bluebird.each(taggableIdOrArns, arn => this.tagRds(<string> arn))
                                .then(() => resolve(true))
                                .catch(err => reject(err));

                        })
                        .catch(err => {
                            reject(err);
                        });
                }else if(f == "ELB"){
                    this.applyCloudWatchAlarms(alarms).then(() => {
                        const tagParams = {
                            ResourceArns: <string[]> taggableIdOrArns,
                            Tags: this.getCloudWatchTag()
                        };
                        this.elb.addTags(tagParams, (err, results) => {
                            if (err) {
                                return reject(err);
                            }

                            resolve(true);
                        });
                    });
                }else if(f == "Redshift"){
                    this.applyCloudWatchAlarms(alarms).then(() => {
                        Bluebird.each(taggableIdOrArns, arn => this.tagRedshift(<string> arn))
                            .then(() => resolve(true))
                            .catch(err => reject(err));
                    });
                }else{
                    this.onNever(f);
                }
            });
        })
        .then(() => {
            this.log("Applied alarms and tags successfully.");
            process.exit(0);
        })
        .catch(err => {
            this.onFatalError("Error adding alarms.", err);
        });

    }

    private tagRedshift(arn : string) : Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const tagParams = {ResourceName: arn, Tags: this.getCloudWatchTag()};
            this.redshift.createTags(tagParams, (err, results) => {
                if(err){
                    return reject(err);
                }

                resolve(true);
            });
        });
    }

    private getRedshiftAlarms() : Promise<SavedAlarm[]> {

        return new Promise<SavedAlarm[]>((resolve, reject) => {
            this.getRedshiftInfo().then((targetClusters) => {
                const alarms = targetClusters.map(f => {
                    if(!f.ClusterIdentifier){
                        throw "Missing cluster identifier.";
                    }

                    const arn = "arn:aws:redshift:" + this.config.region + ":" + this.accountId + ":cluster:" + f.ClusterIdentifier;
                    return new SavedAlarm(arn, this.getRedshiftAlarmsForCluster(f));
                });
                resolve([]);
            })
            .catch(err => {
               reject(err);
            });
        });

    }

    private getRedshiftAlarmsForCluster(cluster : AWS.Redshift.Cluster) : PutMetricAlarmInput[] {
        if(!cluster.ClusterIdentifier){
            throw "Null identifier on Redshift?";
        }

        /**
         * CPUUtilization > 95% for 5 minutes
         * HealthStatus = 0 for 5 minutes
         * PercentageDiskSpaceUsed > 95% for 5 minutes
         */

        return [
            {
                ActionsEnabled: true,
                AlarmName: "SetfiveCloudAutoWatch: CPU utilization over 95% (" + cluster.ClusterIdentifier + ")",
                ComparisonOperator: "GreaterThanThreshold",
                MetricName: "CPUUtilization",
                Namespace: "AWS/Redshift",
                Period: 60,
                EvaluationPeriods: 5,
                Threshold: 95,
                Statistic: "Average",
                Dimensions: [{Name: "ClusterIdentifier", Value: cluster.ClusterIdentifier}],
                AlarmActions: [this.config.notificationArn]
            },
            {
                ActionsEnabled: true,
                AlarmName: "SetfiveCloudAutoWatch: Health status is 0 (" + cluster.ClusterIdentifier + ")",
                ComparisonOperator: "LessThanOrEqualToThreshold",
                MetricName: "HealthStatus",
                Namespace: "AWS/Redshift",
                Period: 60,
                EvaluationPeriods: 5,
                Threshold: 0,
                Statistic: "Average",
                Dimensions: [{Name: "ClusterIdentifier", Value: cluster.ClusterIdentifier}],
                AlarmActions: [this.config.notificationArn]
            },
            {
                ActionsEnabled: true,
                AlarmName: "SetfiveCloudAutoWatch: Disk space over 95% (" + cluster.ClusterIdentifier + ")",
                ComparisonOperator: "GreaterThanThreshold",
                MetricName: "PercentageDiskSpaceUsed",
                Namespace: "AWS/Redshift",
                Period: 60,
                EvaluationPeriods: 5,
                Threshold: 95,
                Statistic: "Average",
                Dimensions: [{Name: "ClusterIdentifier", Value: cluster.ClusterIdentifier}],
                AlarmActions: [this.config.notificationArn]
            },
        ];
    }

    private getRedshiftInfo() : Promise<AWS.Redshift.Cluster[]> {

        return new Promise<AWS.Redshift.Cluster[]>((resolve, reject) => {
            this.redshift.describeClusters((err, results) => {
                if(err){
                    return reject(err);
                }

                if(!results.Clusters){
                    return resolve([]);
                }

                const targetClusters = _.reject(results.Clusters, f => {
                    return _.find(f.Tags, f => f.Key == "SetfiveCloudAutoWatch" && f.Value);
                });

                this.log("Found " + targetClusters.length + " Redshift clusters without SetfiveCloudAutoWatch tag.");
                targetClusters.forEach(cluster => {
                    this.log("Identifier: " + cluster.ClusterIdentifier);
                });

                resolve(targetClusters);
            });
        });

    }

    private getELBAlarms(): Promise<SavedAlarm[]> {
        return new Promise<SavedAlarm[]>((resolve, reject) => {

            this.getELBInfo()
                .then(results => {
                    const alarms = results.map(f => {
                       if(!f.instance.LoadBalancerArn){
                           throw "Missing load balancer ARN?";
                       }

                       return new SavedAlarm(f.instance.LoadBalancerArn, this.getELBAlarmsForInstance(f));
                    });
                    resolve(alarms);
                })
                .catch(err => {
                    reject(err);
                });

        });
    }

    private tagRds(arn : string) : Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            this.rds.addTagsToResource({ResourceName: arn, Tags: this.getCloudWatchTag()}, (err, result) => {
                if(err){
                    return reject(err);
                }

                resolve(true);
            });
        });
    }

    private getRdsAlarms() : Promise<SavedAlarm[]> {
        return new Promise<SavedAlarm[]>((resolve, reject) => {

            this.getRdsInfo()
                .then(results => {
                    const alarms = results.map(f => {
                       if(!f.DBInstanceArn){
                           throw "Missing DB instance ARN?";
                       }

                       return new SavedAlarm(f.DBInstanceArn, this.getRdsAlarmsForInstance(f));
                    });

                    resolve(alarms);
                })
                .catch(err => {
                    reject(err);
                });

        });
    }

    private confirmActions() : Promise<boolean> {

        return new Promise<boolean>((resolve, reject) => {
            this.log("Continue? (Y = Yes, S = Skip, Or we'll quit)");

            process.stdin.on('data', text => {

                process.stdin.removeAllListeners("data");

                text = text.trim();
                if (text == "Y") {
                    resolve(true);
                }else if(text == "S"){
                    this.log("Skipping...");
                    resolve(false);
                }else{
                    this.log("Bailing per your request.");
                    process.exit(-1);
                }
            });

        });

    }

    private getEc2Alarms(): Promise<SavedAlarm[]> {

        return new Promise<SavedAlarm[]>((resolve, reject) => {
            this.getEc2Info()
                .then(results => {
                    const ec2Alarms = results.map(f => {
                        if(!f.InstanceId){
                            throw "Misisng instance id.";
                        }
                      return new SavedAlarm(f.InstanceId, this.getEc2AlarmsForInstance(f));
                    });

                    resolve(ec2Alarms);
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

    private getEc2AlarmsForInstance(f : Instance) : PutMetricAlarmInput[] {
        if(!f.InstanceId){
            throw "Null instanceId on EC2?";
        }

        return [
            {
                ActionsEnabled: true,
                AlarmName: "SetfiveCloudAutoWatch: Status check failed (" + f.InstanceId + ")",
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
                AlarmName: "SetfiveCloudAutoWatch: CPU utilization over 95% (" + f.InstanceId + ")",
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
                AlarmName: "SetfiveCloudAutoWatch: Network I/O low (" + f.InstanceId + ")",
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
        ];
    }

    private getEc2AlarmsForInstances(instances : Instance[]) : PutMetricAlarmInput[] {
        /**
         * StatusCheckFailed > 0
         * CPUUtilization > 95% for 5 minutes
         * NetworkPacketsOut < 100 for 5 minutes
         * Note: You can still run out of disk space on any of your volumes
         */

        const result = instances.map(f => {
            return this.getEc2AlarmsForInstance(f);
        });

        return _.flatten(result);
    }

    private getEc2Info() : Promise<Instance[]> {
        this.log("Describing EC2 instances...");

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

                this.log("Found " + result.length + " EC instances without SetfiveCloudAutoWatch tag.");
                result.forEach(instance => {
                    this.log("ID: " + instance.InstanceId);
                });

                resolve(result);
            });
        });
    }

    private getRdsAlarmsForInstance(f : AWS.RDS.DBInstance) : PutMetricAlarmInput[] {
        if(!f.DBInstanceIdentifier){
            throw "Null identifier on RDS?";
        }

        return [
            {
                ActionsEnabled: true,
                AlarmName: "SetfiveCloudAutoWatch: CPU utilization over 95% (" + f.DBInstanceIdentifier + ")",
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
                AlarmName: "SetfiveCloudAutoWatch: Storage space less than 1GB (" + f.DBInstanceIdentifier + ")",
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
                AlarmName: "SetfiveCloudAutoWatch: Query depth over 100 (" + f.DBInstanceIdentifier + ")",
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
        ];
    }

    private getRdsAlarmsForInstances(instances : AWS.RDS.DBInstance[]) : PutMetricAlarmInput[] {
        /*
        * CPUUtilization > 95% for 5 minute
        * FreeStorageSpace < 1gb for 5 minute
        * DiskQueueDepth > 100 for 5 minutes
        */
        const result = instances.map(f => this.getRdsAlarmsForInstance(f));
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
        this.log("Describing RDS instances...");

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

                       this.log("Found " + instances.length + " without SetfiveCloudAutoWatch tag.");
                       instances.forEach(instance => {
                           this.log("ID: " + instance.Instance.DBInstanceArn);
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

    private getELBAlarmsForInstance(f : LoadBalancerWithStatistics) : PutMetricAlarmInput[] {
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
                AlarmName: "SetfiveCloudAutoWatch: 500s over 0 for 5 minutes (" + cloudwatchDimension + ")",
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
                AlarmName: "SetfiveCloudAutoWatch: Response time over 200% of 24hr max for 5 minutes (" + cloudwatchDimension + ")",
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
                AlarmName: "SetfiveCloudAutoWatch: Requests over 200% of 24hr max for 5 minutes (" + cloudwatchDimension + ")",
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
    }

    private getELBAlarmsForInstances(instances : LoadBalancerWithStatistics[]) : PutMetricAlarmInput[] {
        /**
         * HTTPCode_Target_5XX_Count > 0 for 5 minutes
         * TargetResponseTime > [max last 24 hrs] for 5 minutes
         * RequestCount > [max last 24 hrs]
         */

        const result = instances.map(f => this.getELBAlarmsForInstance(f));
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

        this.log("Describing ELB/ALB instances...");

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

                        this.log("Found " + targetInstances.length + " without SetfiveCloudAutoWatch tag.");

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

    private getCloudWatchTag() : CloudWatchTag {
        return [{Key: "SetfiveCloudAutoWatch", Value: moment().toISOString()}];
    }

    private prettyPrintAlarms(alarms : PutMetricAlarmInput[]) : void {
        alarms.forEach(alarm => {
            console.log(JSON.stringify(alarm, null, 2));
        });
    }

    private log(msg : string) : void {
        console.log(colors.gray(moment().toISOString()) + ": " + msg);
    }

    private onNever(o : never) : void {
        this.onFatalError("Unrecognized: " + o, "");
    }

    private onFatalError(msg : string, error : any) : void {
        console.log(colors.red(msg));
        if(error) {
            console.log(error);
        }
        process.exit(-1);
    }
}

(new Main()).main();