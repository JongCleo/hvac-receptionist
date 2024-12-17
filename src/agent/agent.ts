import * as Sentry from '@sentry/node';
import dotenv from 'dotenv';
import fs from 'fs';
import OpenAi from 'openai';
import OpenAI from 'openpipe/openai';
import { WebSocket } from 'ws';
import { logger } from '../helpers/logger.js';
import prismaClient from '../helpers/prisma.js';
import {
  bookAppointment,
  findAppointments,
} from '../integrations/odooAppointments.js';
import { RetellRequest, RetellResponse } from '../types/retell.js';
import { end_call, update_call_lead } from './functions.js';
// DO NOT MOVE. MUST BE CALLED BEFORE ANY LOCAL IMPORTS
dotenv.config();

//////////////////////////////////// Constants
export interface ToolCall {
  id: string;
  funcName: string;
  arguments: Record<string, any>;
  result?: string;
  end_call?: boolean;
}

export class RetellAgent {
  private client: OpenAI;
  private openaiClient: OpenAI;
  private modelName: string;
  private toolModelName: string | null = null;
  private toolSystemPrompt: string =
    'You are a helpful assistant with access to functions.';
  private systemPrompt: string;
  private functionTools: OpenAi.Chat.Completions.ChatCompletionTool[];
  private baseUrl: string;
  private llmApiKey: string;
  private dbCallId: string;
  private ws: WebSocket | null = null;

  constructor(
    model: string,
    prompt: string,
    tools: OpenAi.Chat.Completions.ChatCompletionTool[],
    dbCallId: string,
    ws?: WebSocket,
  ) {
    const GENERAL_PROMPT = fs.readFileSync(
      'src/prompts/RETELL_SYSTEM_PROMPT.txt',
      'utf8',
    );
    this.modelName = model;
    this.systemPrompt = GENERAL_PROMPT + prompt;
    this.functionTools = tools;
    this.dbCallId = dbCallId;
    if (ws) this.ws = ws;
    if (model.toLowerCase().includes('fireworks')) {
      this.baseUrl = 'https://api.fireworks.ai/inference/v1';
      this.llmApiKey = process.env['FIREWORKS_API_KEY'] || '';
      // this.toolModelName = 'accounts/fireworks/models/firefunction-v1';
      this.toolModelName = 'gpt-3.5-turbo';
    } else {
      this.baseUrl = 'https://api.openai.com/v1';
      this.llmApiKey = process.env['OPENAI_API_KEY'] || '';
    }

    this.client = new OpenAI({
      baseURL: this.baseUrl,
      apiKey: this.llmApiKey,
      // per https://github.com/openai/openai-node
      // will retry for 408 Request Timeout, 409 Conflict, 429 Rate Limit, and >=500 Internal errors
      maxRetries: 3,
      timeout: 30 * 1000, // 30 seconds (default is 10 minutes)
      openpipe: {
        apiKey: process.env.OPENPIPE_API_KEY, // defaults to process.env["OPENPIPE_API_KEY"]
      },
    });

    this.openaiClient = new OpenAI({
      apiKey: process.env['OPENAI_API_KEY'],
      // per https://github.com/openai/openai-node
      // will retry for 408 Request Timeout, 409 Conflict, 429 Rate Limit, and >=500 Internal errors
      maxRetries: 3,
      timeout: 30 * 1000, // 30 seconds (default is 10 minutes)
      openpipe: {
        apiKey: process.env.OPENPIPE_API_KEY, // defaults to process.env["OPENPIPE_API_KEY"]
      },
    });
  }

  private updateSystemPrompt(
    messages: OpenAi.ChatCompletionMessageParam[],
    newSystemPrompt: string,
  ) {
    const systemMessage = messages.find((row) => row.role === 'system');
    if (systemMessage) {
      systemMessage.content = newSystemPrompt;
    }
  }

  private parseRetellTranscript(request: RetellRequest) {
    let messages: OpenAi.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemPrompt },
    ];

    // convert Retell transcript into OpenAI format
    for (let message of request.transcript) {
      messages.push({
        role: message.role === 'agent' ? 'assistant' : 'user',
        content: message.content ? message.content : '',
      });
    }

    if (request.interaction_type === 'reminder_required') {
      messages.push({
        role: 'user',
        content: '(Now the user has not responded in a while, you would say:)',
      });
    }
    return messages;
  }

  async streamResponse(
    messages: OpenAi.ChatCompletionMessageParam[],
    modelNameOverride?: string,
  ): Promise<AsyncIterable<OpenAi.ChatCompletionChunk>> {
    const model = modelNameOverride ?? this.toolModelName ?? this.modelName; //If using llama3, use gpt3.5 for tool calling
    const client = modelNameOverride ? this.client : this.openaiClient; //If using llama3, use gpt3.5 for tool calling
    // const client = this.client;
    // const systemPrompt =
    // modelNameOverride ?? this.toolSystemPrompt ?? this.systemPrompt;
    // this.updateSystemPrompt(messages, systemPrompt);

    const stream = await client.chat.completions.create({
      model: model,
      messages: messages,
      tools: this.functionTools,
      tool_choice: 'auto',
      temperature: 0,
      max_tokens: 200,
      stream: true,
      openpipe: {
        tags: {
          prompt_id: 'agent_responses',
          any_key: '1',
        },
        logRequest: true,
      },
    });

    return async function* () {
      try {
        for await (const event of stream) {
          console.log(JSON.stringify(event.choices[0]));
          yield event;
        }
      } catch (err) {
        console.error('Error processing stream:', err);
      }
    }.call(this);
  }

  sendResponse(
    response_id: number,
    content: string,
    content_complete: boolean,
    end_call: boolean,
  ) {
    logger.info(
      `DB Call Id: ${this.dbCallId}, response_id: ${response_id}, Responding with: ${content || ''}`,
    );
    const res: RetellResponse = {
      response_id: response_id,
      content: content || '',
      content_complete: content_complete,
      end_call: end_call,
    };
    if (this.ws) this.ws.send(JSON.stringify(res));
    else console.log(JSON.stringify(res));
  }

  async retellRespond(dbCallId: string, retellReq: RetellRequest) {
    if (retellReq.interaction_type === 'update_only') return; //Process live transcript update if needed
    logger.info(`Drafting response for call: ${dbCallId}`);
    // console.log(JSON.stringify(retellReq.transcript));

    let toolCall: ToolCall | null = null;
    let toolArguments = '';
    let isFunctionCall = false;
    let messages = this.parseRetellTranscript(retellReq);
    let agentResponse = '';
    logger.info(`User message received: ${JSON.stringify(messages.slice(-1))}`);

    //Get first response from LLM, stream response back
    try {
      const stream = await this.streamResponse(messages);
      for await (const event of stream) {
        const delta = event.choices[0].delta;
        if (
          delta.tool_calls?.[0]?.type === 'function' ||
          (isFunctionCall && delta.tool_calls)
        ) {
          isFunctionCall = true;
          let newToolCall = delta.tool_calls[0];
          if (newToolCall.id) {
            if (toolCall) {
              // console.log('New tool call');
              break; //Skip new functions for now.
            } else {
              logger.info(`New tool call: ${JSON.stringify(newToolCall)}`);
              toolCall = {
                id: newToolCall.id,
                funcName: newToolCall.function?.name || '',
                arguments: {},
              };
            }
          } else toolArguments += newToolCall.function?.arguments || '';
        } else if (delta.content != null) {
          // console.log(delta);
          if (this.modelName.toLowerCase().includes('llama')) {
            // agentResponse += delta.content || '';
            logger.info('No tool called. Switching to llama3');
            const resStream = await this.streamResponse(
              messages,
              this.modelName,
            );
            for await (const chunk of resStream) {
              this.sendResponse(
                retellReq.response_id!,
                chunk.choices[0].delta.content || '',
                false,
                false,
              );
            }
            break;
          } else {
            this.sendResponse(
              retellReq.response_id!,
              delta.content,
              false,
              false,
            );
          }
        }
      }
    } catch (err) {
      logger.error(`Error in llm stream: ${JSON.stringify(err)}`);
      Sentry.captureException(err, {
        extra: {
          dbCallId,
          request: retellReq,
        },
      });
      throw new Error(`Error in llm stream: ${err}`);
    } finally {
      if (toolCall) {
        // Finally Call the tools
        logger.info(`Tool: ${toolCall.funcName} w/ arguments ${toolArguments}`);
        try {
          toolCall.arguments = JSON.parse(toolArguments);
          const content = JSON.stringify(toolCall.arguments.message);
          // Handle end_call by returning the message, calling function, then returning
          if (toolCall.funcName === 'end_call') {
            this.sendResponse(retellReq.response_id!, content, true, true);
            await this.callFunction(toolCall);
            return;
          } else {
            this.sendResponse(retellReq.response_id!, content, false, false);
            const responseToolCall = await this.callFunction(toolCall);
            messages.push({
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: responseToolCall.id,
                  type: 'function',
                  function: {
                    name: responseToolCall.funcName,
                    arguments: toolArguments,
                  },
                },
              ],
            });
            messages.push({
              role: 'tool',
              tool_call_id: responseToolCall.id,
              content: responseToolCall.result || '',
            });
            logger.info('Generating response message for tool call');
            const resStream = await this.streamResponse(
              messages,
              this.modelName,
            );
            for await (const chunk of resStream) {
              if (content)
                this.sendResponse(
                  retellReq.response_id!,
                  chunk.choices[0].delta.content || '',
                  false,
                  responseToolCall.end_call || false,
                ); //end the call if end_call was called
            }
          }
        } catch (err) {
          logger.error(
            `Error in calling tool: ${JSON.stringify(err, null, 2)}`,
          );
          Sentry.captureException(err, {
            extra: {
              dbCallId,
              request: retellReq,
            },
          });
          throw new Error(`Error in calling tool: ${err}`);
        }
      }
      this.sendResponse(retellReq.response_id!, '', true, false); //Send content_complete signal
    }
  }

  private async callFunction(toolCall: ToolCall): Promise<ToolCall> {
    if (toolCall.funcName === 'end_call') {
      await end_call(this.dbCallId);
      toolCall.end_call = true;
    } else if (toolCall.funcName === 'update_call_lead') {
      await update_call_lead(toolCall.arguments.lead_details, this.dbCallId);
    } else if (toolCall.funcName === 'find_appointments') {
      const availabilities = await findAppointments(
        toolCall.arguments.appointmentType,
      );
      toolCall.result = availabilities;
    } else if (toolCall.funcName === 'book_appointment') {
      const assignee = toolCall.arguments.assignee;
      let appointmentStart = toolCall.arguments.appointmentStart;
      let appointmentEnd = toolCall.arguments.appointmentEnd;
      const call = await prismaClient.call.findUnique({
        where: { id: this.dbCallId },
      });
      const isAlreadyBooked = call?.appointment_id;

      if (!assignee || !appointmentStart || !appointmentEnd)
        toolCall.result = 'Missing function arguments. Please try again.';
      else if (isAlreadyBooked)
        toolCall.result = 'Appointment already booked. Let user know.';
      else {
        const bookedAppointment = await bookAppointment(
          assignee,
          appointmentStart,
          appointmentEnd,
        );
        await prismaClient.call.update({
          where: { id: this.dbCallId },
          data: { appointment_id: bookedAppointment.id },
        });
        toolCall.result =
          'Appointment booked successfully! \n' +
          JSON.stringify(bookedAppointment);
      }
    }
    return toolCall;
  }
}

// const dbCallId = 'f23c4a3c-7081-4901-874f-36040c26ad47';
// const result = await getModelParametersFromDB(dbCallId);
// // console.log(JSON.stringify(result.functionTools));
// const llmModel = new RetellAgent(
//   // result.modelName,
//   'accounts/fireworks/models/llama-v3-70b-instruct',
//   result.systemPrompt,
//   // '',
//   result.functionTools,
//   dbCallId,
// );

// const retellRequest: RetellRequest = {
//   response_id: 12345,
//   transcript: requestMessages,
//   interaction_type: 'response_required',
// };

// await llmModel.retellRespond(dbCallId, retellRequest);

// // const stream = await llmModel.streamResponse(requestMessages);

// // for await (const response of stream) {
// //   if (response.choices && response.choices.length > 0) {
// //     const choice = response.choices[0];
// //     if (choice.delta && choice.delta.content) {
// //       // console.log(choice.delta.content);
// //       process.stdout.write(choice.delta.content);
// //     }
// //   }
// // }

// process.exit(0);
