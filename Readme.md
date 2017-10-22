<p align="center">
![Logo](/misc/logo.png?raw=true)
</p>

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
