import _ from "lodash";
import faker from "faker";
import * as winston from "winston";
import { azureBlobTransport } from "../lib"

import * as dotenv from "dotenv";

dotenv.config();

var logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.splat(),
        winston.format.json()
    ),
    transports: [
        new (azureBlobTransport)({
            account: {
                name: process.env.ACCOUNT_NAME || "account name",
                key: process.env.ACCOUNT_KEY || "account key"
            },
            containerName: "sample",
            blobName: "samplelogs",
            level: "info",
            bufferLogSize: 1,
            syncTimeout: 0,
            rotatePeriod: "",
            EOL: "\n"
        })
    ]
});

_.times(100).map(v => {
    logger.info(`index ${v} sample log ${faker.lorem.paragraph(3)}`)
})
