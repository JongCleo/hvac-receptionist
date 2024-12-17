import dotenv from 'dotenv';
import winston, { transport } from 'winston';
dotenv.config();

const transports: transport[] = [
  new winston.transports.Console({
    level: 'debug',
  }),
  // new WinstonCloudWatch({
  //   level: 'info',
  //   logGroupName: 'voice-agent-logs',
  //   logStreamName: process.env.CLOUDWATCH_DESTINATION,
  //   awsOptions: {
  //     credentials: {
  //       accessKeyId: process.env.CLOUDWATCH_ACCESS_KEY!,
  //       secretAccessKey: process.env.CLOUDWATCH_SECRET_ACCESS_KEY!,
  //     },
  //     region: 'us-east-2',
  //   },
  // }),
  // reference https://javascript.plainenglish.io/set-up-a-logger-for-your-node-app-with-winston-and-cloudwatch-in-5-minutes-dec0c6c0d5b8
];

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: transports,
});
