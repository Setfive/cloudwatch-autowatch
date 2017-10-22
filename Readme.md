![Logo](/misc/logo.png?raw=true)

## Cloudwatch Autowatch

Amazon's CloudWatch product is great but it's a bit tedious to manually 
configure for lots of EC2s. Sure, you probably should be using something 
like Terraform to manage your AWS infrastructure but for instances when 
you inherit existing AWS resources this should save you some clicking. 
Autowatch will scan EC2, RDS, Redshift, and ELB for untagged resources 
and help you automatically add CloudWatch alarms for those resources.

Autowatch works in two steps:
* First, it will scan your resources and output a JSON file with the 
    alarms that it'll add on CloudWatch
* You can edit this file to add alarms, edit the thresholds, or 
    remove any that aren't relevant
* And then feed the file back to Autowatch and it will add the alarms for you

These alarms should be thought of as starting points, you really 
should add system level monitoring and monitoring specific to your AWS usecase.

### Getting started

You'll need AWS credentials for a user that has permissions to list resources 
and add CloudWatch alarms. You could manually add managed policies for each 
resource or just cheat and use the "AdministratorAccess" managed policy. 
Another option if you're running inside AWS would be to add an IAM Role 
to an EC2 that has the appropriate permissions.

The nodejs AWS client will look for credentials in environment variables or 
authenticate via IAM Roles if available. If you're using access keys, 
just set some environment variables:

```
export AWS_ACCESS_KEY_ID=[your id]
export AWS_SECRET_ACCESS_KEY=[your key]
```

The second thing you'll need to add is an SNS topic for how you want to 
receive notifications. There's a lot of ways to configure this but 
http://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/US_SetupSNS.html 
is a good starting point.  


Now, just grab the code and install the dependencies with npm:

```
git clone git@github.com:Setfive/cloudwatch-autowatch.git
npm install
```

### Run it!

Autowatch can grab the SNS ARN for the topic that you created above. Just run:

```
ashish@ashish:~/workspace/cloudwatch-auto$ ./index.js --action=listSnsTopics
```

Grab that ARN and now you can generate alarms for the untagged 
resources on your account:
```
ashish@ashish:~/workspace/cloudwatch-auto$ ./index.js --action=generateAlarms --notificationArn=[your arn]
```

If everything goes well, you'll have a file called "alarms.json" in the working directory.
And now, feed that file back in to have it add the alarms in CloudWatch:

```
ashish@ashish:~/workspace/cloudwatch-auto$ ./index.js --action=addAlarmsFromFile --input=alarms.json
```

And that's about it!

### Anything else?

Another usecase would be to help monitor EC2s in autoscaling groups that are 
continually being cycled in and out. It would be pretty straightforward to 
orchestrate this to run on a cron job and have it automatically add alarms 
to new EC2 instances as they're started.

To add alarms immediately just set the 'addImmediately' option along 
with 'generateAlarms'

```
ashish@ashish:~/workspace/cloudwatch-auto$ ./index.js --action=generateAlarms --notificationArn=[your arn] --addImmediately=true
```

And lastly, this project is actually written in TypeScript as opposed 
to regular JavaScript as an experiment in writing tools in TypeScript. 
Overall, it was a pretty good experience and I would recommend.

### Usage

```
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
    --notificationArn       The SNS topic ARN to use for notifications. Use with 'generateAlarms'
    --output                The JSON file to output alarms to. Use with 'generateAlarms'
    --input                 The JSON file to add alarms from. Use with 'addAlarmsFromFile'    
    --region                The AWS region to access. Defaults to us-east-1                      
        
Examples:
    # This will create a file named alarms.json
    cloudwatch-auto --action=generateAlarms --notificationArn=arn:aws:sns:us-east-1:123:ContactAndCloudWatch
    
    # Now, create the alarms contained inside alarms.json. You can edit the alarms before adding them.
    cloudwatch-auto --action=addAlarmsFromFile --input=alarms.json               
    
```