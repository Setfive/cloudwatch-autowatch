"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class Config {
    static getConfig() {
        const argvs = process.argv.slice(2);
        if (argvs.length == 0) {
            return { help: true, addImmediately: false, action: "",
                region: "", notificationArn: "", input: "", output: "" };
        }
        const argv = require("minimist")(argvs, { "boolean": ["help", "addImmediately"], "default": { "region": "us-east-1", "output": "alarms.json" } });
        return argv;
    }
    static outputHelp() {
        const help = `
Usage cloudwatch-auto [options]

cloudwatch-auto automatically adds baseline alarms to your AWS resources. 
These alarms are intended to serve only as a starting point, mostly useful when you're just starting out with AWS.

Note: The AWS client authenticates automatically using IAM roles, environment variables, or a JSON credential file.
      One of these must be available in order for cloudwatch-auto to work.  

Action Flags:
Pass any one of these as an argument to --action. Ex. --action=generateAlarms

    generateAlarms:             Generates a file based on AWS resources. The file is alarms.json by default.   
    addAlarmsFromFile:          Add alarms from a JSON file specified by --input (see below)
    listSnsTopics:              Lists the available SNS topics
    help:                       Prints this message
    
Options:
    --notificationArn           The SNS topic ARN to use for notifications. Use with 'generateAlarms'
    --output                    The JSON file to output alarms to. Use with 'generateAlarms'
    --addImmediately            Set if you want to just add alarms immediately. Use with 'generateAlarms'
    --input                     The JSON file to add alarms from. Use with 'addAlarmsFromFile'    
    --region                    The AWS region to access. Defaults to us-east-1                      
        
Examples:
    # This will create a file named alarms.json
    cloudwatch-auto --action=generateAlarms --notificationArn=arn:aws:sns:us-east-1:123:ContactAndCloudWatch
    
    # Now, create the alarms contained inside alarms.json. You can edit the alarms before adding them.
    cloudwatch-auto --action=addAlarmsFromFile --input=alarms.json               
`;
        console.log(help);
        process.exit(0);
    }
}
exports.Config = Config;
