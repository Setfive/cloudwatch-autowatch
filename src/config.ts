export class Config {

    public readonly region : string;
    public readonly notificationArn : string;
    public readonly generateAlarms : boolean;
    public readonly input : string;
    public readonly help : boolean;

    public static getConfig() : Config {
        const argvs = process.argv.slice(2);
        if(argvs.length == 0){
            return {help: true, generateAlarms : false,
                    region: "", notificationArn: "", input: ""};
        }

        const argv = require("minimist")(argvs, {"boolean": ["help", "generateAlarms"], "default": {"region": "us-east-1"}});

        return <Config> argv;
    }

    public static outputHelp() : void {
        const help = `
Usage cloudwatch-auto [options]

cloudwatch-auto automatically adds baseline alarms to your AWS resources. 
These alarms are intended to serve only as a starting point, mostly useful when you're just starting out with AWS.

Note: The AWS client authenticates automatically using IAM roles, environment variables, or a JSON credential file.
      One of these must be available in order for cloudwatch-auto to work.  

Action Flags:        
    --generateAlarms        Generates alarms.json based on AWS resources   
    --input                 A JSON file with alarms to add

Options:
    --notificationArn       The SNS topic ARN to use for notifications
    --region                The AWS region to access. Defaults to us-east-1
    --help                  Prints this message
        
Examples:
    # This will create a file named alarms.json
    cloudwatch-auto --generateAlarms --notificationArn=arn:aws:sns:us-east-1:123:ContactAndCloudWatch
    
    # Now, create the alarms contained inside alarms.json. You can edit the alarms before adding them.
    cloudwatch-auto --input=alarms.json               
`;
        console.log(help);
        process.exit(0);
    }
}