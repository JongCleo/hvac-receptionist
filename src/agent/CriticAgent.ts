import dotenv from 'dotenv';
import fs from 'fs';
import OpenAi from 'openai';
import OpenAI from 'openpipe/openai';
import { performance } from 'perf_hooks';
import readline from 'readline';

dotenv.config();

export class CriticAgent {
  private client: OpenAI;
  private systemPrompt: string;
  private messages: OpenAi.ChatCompletionMessageParam[];

  constructor() {
    this.client = new OpenAI({
      baseURL: 'https://api.fireworks.ai/inference/v1',
      apiKey: process.env['FIREWORKS_API_KEY'],
      // apiKey: process.env['OPENAI_API_KEY'],
      // per https://github.com/openai/openai-node
      // will retry for 408 Request Timeout, 409 Conflict, 429 Rate Limit, and >=500 Internal errors
      maxRetries: 3,
      timeout: 30 * 1000, // 30 seconds (default is 10 minutes)
      openpipe: {
        apiKey: process.env.OPENPIPE_API_KEY, // defaults to process.env["OPENPIPE_API_KEY"]
      },
    });
    this.systemPrompt = fs.readFileSync('src/prompts/CRITIC.txt', 'utf8');
    this.messages = [{ role: 'system', content: this.systemPrompt }];
  }

  async generateResponse(
    user_query: string,
  ): Promise<AsyncGenerator<OpenAi.ChatCompletionChunk>> {
    this.messages.push({ role: 'user', content: `Format("${user_query}")` });
    const stream = await this.client.chat.completions.create({
      model: 'accounts/fireworks/models/llama-v3-70b-instruct',
      // model: 'gpt-3.5-turbo',
      messages: this.messages,
      temperature: 0,
      max_tokens: 150,
      stream: true,
      openpipe: {
        tags: {
          prompt_id: 'agent_responses',
          any_key: '1',
        },
        logRequest: true,
      },
    });

    let assistantMessage = '';

    return async function* (this: CriticAgent) {
      try {
        for await (const event of stream) {
          if (
            event.choices &&
            event.choices[0].delta &&
            event.choices[0].delta.content
          ) {
            const content = event.choices[0].delta.content;
            assistantMessage += content;
            yield event;
          }
        }
        this.messages.push({ role: 'assistant', content: assistantMessage });
      } catch (err) {
        console.error('Error processing stream:', err);
      }
    }.call(this);
  }
}

const agent = new CriticAgent();
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function promptUser() {
  rl.question('User: ', async (input) => {
    const startTime = performance.now();
    console.log('Agent: ');
    const stream = await agent.generateResponse(input);
    for await (const response of stream) {
      if (response.choices && response.choices.length > 0) {
        const choice = response.choices[0];
        if (choice.delta && choice.delta.content) {
          process.stdout.write(choice.delta.content);
        }
      }
    }
    const endTime = performance.now();
    const totalTime = endTime - startTime;
    console.log(`\nRoundtrip time: ${totalTime.toFixed(2)} ms`);
    console.log('\n');
    promptUser();
  });
}

promptUser();
