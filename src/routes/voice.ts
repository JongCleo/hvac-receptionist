import * as Sentry from '@sentry/node';
import express, { NextFunction, Request, Response } from 'express';

import Twilio from 'twilio';
import { z } from 'zod';
import { logger } from '../helpers/logger.js';
import prismaClient from '../helpers/prisma.js';
import retellClient from '../helpers/retell.js';
import { CallCategory, CallStatus } from '../types/call.js';

const voiceRouter = express.Router();

async function saveCallToDB(
  twilioCallSid: string,
  toNumber: string,
  fromNumber: string,
) {
  const agent = await prismaClient.agent.findFirst({
    where: {
      OR: [{ real_number: toNumber }, { test_number: toNumber }],
    },
  });
  if (!agent) {
    throw new Error(
      `There is no agent with the ${toNumber}. This is likely caused by invalid data in the agent table. Make sure test_number and real_number fields are formatted using twilio's E.164 standard and that they are not null`,
    );
  }
  const agentConfig = await prismaClient.agent_configuration.findFirst({
    where: {
      agent_id: agent.id,
      active_config: true,
    },
  });
  if (!agentConfig) {
    throw new Error(
      `There is no active configuration for agent ${agent.id}. This is likely caused by invalid data in the agent_configuration table. Make sure there is at least one active configuration for each agent.`,
    );
  }

  const call = await prismaClient.call.create({
    data: {
      org_id: agent.org_id,
      agent_config_id: agentConfig.id,
      started_at: new Date(),
      lead_metadata: {
        twilioCallSid,
        toNumber,
        fromNumber,
      },
      status: CallStatus.AUTO_CLOSED,
      category: CallCategory.ABRUPT_HUNGUP,
    },
  });
  if (!call) {
    throw new Error('Failed to create new call to DB');
  }
  return call;
}
voiceRouter.post(
  '/twilio-voice-webhook',
  async (req: Request, res: Response, next: NextFunction) => {
    // get from beta.retell.com/dashboard

    const twilioCallSid = req.body.CallSid;
    const toNumber = req.body.To;
    const fromNumber = req.body.From;
    logger.info(`Call incoming to ${toNumber}, from: ${fromNumber}`);
    let call;
    try {
      call = await saveCallToDB(twilioCallSid, toNumber, fromNumber);
    } catch (err) {
      Sentry.captureException(err, {
        extra: {
          twilioCallSid,
          toNumber,
          fromNumber,
        },
      });
      next(err);
      return;
    }

    try {
      if (process.env.KILL_SWITCH === 'true') {
        logger.info('Kill switch is on, returning early');
        const response = new Twilio.twiml.VoiceResponse();
        response.say(
          'Thank you for calling Unilux. You can call us from Monday to Friday, between 8am to 4pm, or leave a message after the beep.',
        );
        response.record({
          action: `/voice/recording-finished?callId=${call.id}`,
          method: 'POST',
          maxLength: 120,
          finishOnKey: '#',
          timeout: 60,
        });
        res.set('Content-Type', 'text/xml');
        res.send(response.toString());
        return;
      }

      const RETELL_AGENT_ID =
        process.env.RETELL_AGENT_ID || '4f0fbb106ba5d4673c9e5eb937ecded5';

      const callResponse = await retellClient.call.register({
        agent_id: RETELL_AGENT_ID,
        audio_websocket_protocol: 'twilio',
        audio_encoding: 'mulaw',
        sample_rate: 8000,
        metadata: {
          dbCallId: call?.id,
        },
      });

      if (callResponse?.call_id) {
        const response = new Twilio.twiml.VoiceResponse();
        const start = response.connect();
        const retellCallId = callResponse.call_id;
        const stream = start.stream({
          url: `wss://api.retellai.com/audio-websocket/${retellCallId}`,
        });
        await prismaClient.call.update({
          where: {
            id: call.id,
          },
          data: {
            debug_metadata: {
              retellCallId,
            },
          },
        });

        res.set('Content-Type', 'text/xml');
        res.send(response.toString());
      }
    } catch (err) {
      logger.error(`Error registering call: ${JSON.stringify(err, null, 2)}}`);
      Sentry.captureException(err, {
        extra: {
          dbCallId: call?.id,
          agentId: process.env.RETELL_AGENT_ID,
        },
      });
      res.status(500).send();
    }
  },
);

const webhookPayloadSchema = z.object({
  event: z.string(),
  data: z.object({
    call_id: z.string(),
    agent_id: z.string(),
    start_timestamp: z.number(),
    end_timestamp: z.number().optional(),
    transcript: z.string(),
    recording_url: z.string().optional(),
    metadata: z.record(z.any()),
  }),
});

voiceRouter.post(
  '/recording-finished',
  async (req: Request, res: Response, next: NextFunction) => {
    const callId = req.query.callId;
    const { RecordingDuration, RecordingSid } = req.body;
    if (!callId || !RecordingDuration || !RecordingSid) {
      res.status(400);
      next(
        new Error('Missing parameters in recording-finished webhook request'),
      );
    }
    try {
      const directoryPrefix = process.env.TWILIO_CALL_SID_PREFIX;
      const durationInSeconds = parseInt(RecordingDuration, 10);

      await prismaClient.call.update({
        where: {
          id: callId as string,
        },
        data: {
          storage_uri: directoryPrefix + RecordingSid,
          duration_seconds: durationInSeconds,
        },
      });
    } catch (error) {
      Sentry.captureException(error, {
        extra: {
          callId,
        },
      });
      res.status(500);
      next(
        new Error(
          `Error updating call transcript while : ${JSON.stringify(error)}`,
        ),
      );
    }
    res.status(200).send();
  },
);
voiceRouter.post(
  '/retell-webhook',
  async (req: Request, res: Response, next: NextFunction) => {
    const webHookEnv = req.query.environment;
    logger.info(`query params: ${JSON.stringify(req.query)}`);
    const isStaging = process.env.DATABASE_URL?.includes('orange-sea');
    res.status(200).json({ received: true });
  },

  //   if (
  //     (webHookEnv === 'staging' && !isStaging) ||
  //     (webHookEnv === 'production' && isStaging)
  //   ) {
  //     logger.info(
  //       `Webhook enviroment param: ${webHookEnv} does not match  ${isStaging ? 'staging' : 'production'} database. ignoring webhook request.`,
  //     );
  //     res.status(200);
  //   }

  //   const retellSignature = req.header('X-Retell-Signature');

  //   if (!retellSignature) {
  //     res.status(400);
  //     next(new Error('Retell signature not found in webhook request'));
  //   }

  //   // const isLegit = retellClient.(
  //   //   JSON.stringify(req.body),
  //   //   process.env.RETELL_API_KEY!,
  //   //   retellSignature!,
  //   // );

  //   // if (!isLegit) {
  //   //   res.status(500);
  //   //   next(
  //   //     new Error(
  //   //       'Retell signature verification failed, check if the API key is valid',
  //   //     ),
  //   //   );
  //   // }

  //   if (req.body.event !== 'call_ended') {
  //     return res.status(200).json({ received: true });
  //   }
  //   const validatedPayload = webhookPayloadSchema.safeParse(req.body);
  //   if (!validatedPayload.success) {
  //     res.status(400);
  //     next(
  //       new Error(
  //         `Error validating webhook payload: ${JSON.stringify(validatedPayload.error)}`,
  //       ),
  //     );
  //     // to make typescript's compiler happy with zod's safeParse
  //     // need to return here even though we never reach this point
  //     return;
  //   }

  //   const {
  //     metadata,
  //     call_id: retellCallId,
  //     start_timestamp: startTimestamp,
  //     end_timestamp: endTimestamp,
  //     transcript,
  //     recording_url: recordingUrl,
  //   } = validatedPayload.data.data;

  //   const dbCallId = metadata?.dbCallId;
  //   logger.info(
  //     `Call Id: ${retellCallId} Post Processing call transcript and recording in webhook.`,
  //   );

  //   let durationInSeconds = 0;
  //   if (startTimestamp && endTimestamp) {
  //     durationInSeconds = Math.round((endTimestamp - startTimestamp) / 1000);
  //   }
  //   try {
  //     const reformattedTranscript = transcript
  //       ?.split('\n')
  //       .map((line: string) => {
  //         const [role = '', content = ''] = line.includes(': ')
  //           ? line.split(': ')
  //           : ['', ''];
  //         return { role, content };
  //       });
  //     await prismaClient.call.update({
  //       where: {
  //         id: dbCallId!,
  //       },
  //       data: {
  //         transcript: {
  //           conversation: reformattedTranscript || {},
  //         },
  //         ...(durationInSeconds > 0 && {
  //           duration_seconds: durationInSeconds,
  //         }),
  //         storage_uri: recordingUrl,
  //       },
  //     });
  //   } catch (error) {
  //     res.status(500);
  //     next(
  //       new Error(
  //         `Retell Call Id: ${retellCallId} Error updating call ${dbCallId} in Prisma: ${JSON.stringify(error)}`,
  //       ),
  //     );
  //   }

  //   logger.info(`Retell Call Id: ${retellCallId} Post Processing complete.`);
  //   res.status(200).json({ received: true });
  // },
);
export default voiceRouter;
