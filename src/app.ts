import * as Sentry from '@sentry/node';
import axios from 'axios';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import expressWs from 'express-ws';
import { RawData, WebSocket } from 'ws';
import { RetellAgent } from './agent/agent.js';
import { logger } from './helpers/logger.js';
import prismaClient, { getModelParametersFromDB } from './helpers/prisma.js';
import retellClient from './helpers/retell.js';
import { errorHandler, logRequest } from './middleware.js';
import voiceRouter from './routes/voice.js';
import { CallCategory, CallStatus } from './types/call.js';
import { RetellRequest, RetellResponse } from './types/retell.js';
// DO NOT MOVE.
// MUST BE CALLED BEFORE ANY LOCAL IMPORTS
dotenv.config();

const temp = express();
const app = expressWs(temp).app;

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    // enable HTTP calls tracing
    new Sentry.Integrations.Http({ tracing: true }),
    // enable Express.js middleware tracing
    new Sentry.Integrations.Express({ app }),
  ],
});

// Do not move. Must be called after Sentry.init and before any other middleware
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

app.use(logRequest);
app.get('/', (req: Request, res: Response) => {
  res.send(`Yepooopoo it's healthy!`);
});
app.use('/voice', voiceRouter);
app.ws('/llm-websocket/:call_id', async (ws: WebSocket, req: Request) => {
  const retellCallId = req.params.call_id;
  let llmClient: RetellAgent;

  let dbCallId: string;
  try {
    const res = await retellClient.call.retrieve(retellCallId);
    dbCallId = (res as any).metadata?.dbCallId ?? '';

    if (process.env.NODE_ENV == 'development' && !dbCallId) {
      dbCallId = 'c6d7855c-fe18-4cba-9569-1c751f8a4dda';
    }

    if (!dbCallId) {
      logger.error(
        `DbcallId doesn't exist in Retell Call Object: ${retellCallId}`,
      );
    }

    const modelParams = await getModelParametersFromDB(dbCallId);
    logger.info(JSON.stringify(modelParams.introMessage));

    llmClient = new RetellAgent(
      // modelParams.modelName,
      modelParams.modelName,
      modelParams.systemPrompt,
      modelParams.functionTools,
      dbCallId,
      ws,
    );

    const beginMessage: RetellResponse = {
      response_id: 0,
      content: modelParams.introMessage,
      content_complete: true,
      end_call: false,
    };
    ws.send(JSON.stringify(beginMessage));
  } catch (err) {
    Sentry.captureException(err, {
      extra: {
        retellCallId,
      },
    });
    logger.error(
      `Error fetching call details for Retell Call ID: ${retellCallId}: ${err}. Going to hope this is a transient error and continue.`,
    );
  }

  ws.on('error', (err) => {
    logger.error(
      `Retell Call Id: ${retellCallId} Error received in LLM websocket client: ${err}`,
    );
  });
  ws.on('close', async (err) => {
    // Delay execution by 1 min so retell has time to develop the transcript and recording
    const oneMinute = 60 * 1000;
    setTimeout(async () => {
      const res = await retellClient.call.retrieve(retellCallId);
      logger.info(`Websocket close code: ${err}`);
      //@ts-ignore
      dbCallId = res?.metadata?.dbCallId;

      if (err !== 1000) {
        logger.error(
          `Retell Call Id: ${retellCallId} sudden disconnection from LLM websocket client.`,
        );
        Sentry.captureException(
          new Error('LLM websocket client suddenly disconnected'),
          { extra: { retellCallId, dbCallId } },
        );
        try {
          await prismaClient.call.update({
            where: {
              id: dbCallId!,
            },
            data: {
              status: CallStatus.AUTO_CLOSED,
              category: CallCategory.BUG,
            },
          });
        } catch (error) {
          logger.error(
            `Errorception with updating call transcript while : ${JSON.stringify(error)}`,
          );
        }
      }

      logger.info(
        `Retell Call Id: ${retellCallId} Post Processing call transcript and recording.`,
      );

      const startTimestamp = res?.start_timestamp;
      const endTimestamp = res?.end_timestamp;
      let durationInSeconds = 0;
      if (startTimestamp && endTimestamp) {
        durationInSeconds = Math.round((endTimestamp - startTimestamp) / 1000);
      }
      try {
        const reformattedTranscript = res.transcript
          ?.split('\n')
          .map((line) => {
            const [role = '', content = ''] = line.includes(': ')
              ? line.split(': ')
              : ['', ''];
            return { role, content };
          });
        await prismaClient.call.update({
          where: {
            id: dbCallId!,
          },
          data: {
            transcript: {
              conversation: reformattedTranscript || {},
            },
            ...(durationInSeconds > 0 && {
              duration_seconds: durationInSeconds,
            }),
            storage_uri: res.recording_url,
            debug_metadata: {
              retellCallId,
              publicLog: res.public_log_url,
            },
          },
        });

        const NOTIFY_USERS_WEBHOOK = process.env.NOTIFY_USERS_WEBHOOK || null;
        if (!NOTIFY_USERS_WEBHOOK) {
          logger.info(
            `Retell Call Id: ${retellCallId} NOTIFY_USER_WEBHOOK not found in environment variables.`,
          );
        } else {
          await axios.post(
            NOTIFY_USERS_WEBHOOK,
            {
              dbCallId: dbCallId,
            },
            {
              headers: {
                'Content-Type': 'application/json',
              },
            },
          );
        }
      } catch (error) {
        logger.error(
          `Retell Call Id: ${retellCallId} Error updating call ${dbCallId}: ${JSON.stringify(error)}`,
        );
      }
    }, oneMinute);
  });

  ws.on('message', async (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      logger.error('Got binary message instead of text in websocket.');
      ws.close(1002, 'Cannot find corresponding Retell LLM.');
    }

    if (!dbCallId) {
      logger.info(
        `Retell Call Id: ${retellCallId}, attempting to fetch dbCallId with retries.`,
      );
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await retellClient.call.retrieve(retellCallId);
          //@ts-ignore
          dbCallId = res?.metadata?.dbCallId;
          if (dbCallId) break;
        } catch (error) {
          logger.error(
            `Attempt ${attempt}: Error fetching dbCallId: ${retellCallId} - ${error}`,
          );
          const delay = 2000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      if (!dbCallId) {
        logger.error(
          `Retell Call Id: ${retellCallId} dbCallId not found after retries.`,
        );
        ws.close(1002, 'Retell getCall failed too many times.');
        return;
      }
    }
    const request: RetellRequest = JSON.parse(data.toString());
    llmClient.retellRespond(dbCallId, request).catch((err) => {
      logger.error(
        `Retell Call Id: ${retellCallId} failure in retellResponse: ${err}`,
      );
      ws.close(1002, 'Error processing message.');
    });
  });
});
app.use(errorHandler);
export default app;
