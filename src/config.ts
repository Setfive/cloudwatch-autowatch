export class Config {

    public readonly region : string;
    public readonly notificationArn : string;
    public readonly input : string;

    public static getConfig() : Config {
        const argv = require("minimist")(process.argv.slice(2), {
            "default": {
                "region": "us-east-1"
            }
        });

        return <Config> argv;
    }
}