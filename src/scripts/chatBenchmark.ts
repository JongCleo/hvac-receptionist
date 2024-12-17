import Anthropic from '@anthropic-ai/sdk';
import { AzureKeyCredential, OpenAIClient } from '@azure/openai';
import dotenv from 'dotenv';
import fs from 'fs';
import Groq from 'groq-sdk';
import OpenAi from 'openai';
import { performance } from 'perf_hooks';
import prismaClient from '../helpers/prisma.js';

dotenv.config();

const callId = '10d91dae-8ff4-490e-8376-7e8f544dab15';

const result = await prismaClient.call.findFirst({
  where: {
    id: callId,
  },
  select: {
    agent_configuration: {
      select: {
        system_prompt: true,
        function_calls: true,
      },
    },
  },
});

const FUNCTION_TOOLS: OpenAi.Chat.Completions.ChatCompletionTool[] = result!
  .agent_configuration!
  .function_calls! as unknown as OpenAi.Chat.Completions.ChatCompletionTool[];

const GENERAL_PROMPT = fs.readFileSync(
  'src/prompts/RETELL_SYSTEM_PROMPT.txt',
  'utf8',
);
const SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(
  'src/prompts/SYSTEM_PROMPT.txt',
  'utf8',
);
// const SYSTEM_PROMPT_TEMPLATE = result!.agent_configuration!.system_prompt;
const SYSTEM_PROMPT = GENERAL_PROMPT + SYSTEM_PROMPT_TEMPLATE;
// const SYSTEM_PROMPT = 'you are a helpful assistant';
// const FUNCTION_TOOLS: OpenAi.Chat.Completions.ChatCompletionTool[] = result!
//   .agent_configuration!
//   .function_calls! as unknown as OpenAi.Chat.Completions.ChatCompletionTool[];

// Anthropic setup
const anthropic = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],
});

const groq = new Groq({
  apiKey: process.env['GROQ_API_KEY'],
});

// OpenAI setup
const openaiClient = new OpenAi({
  apiKey: process.env['OPENAI_API_KEY'] || '',
  maxRetries: 3,
  timeout: 30 * 1000,
});

const azureOpenaiClient = new OpenAIClient(
  process.env['AZURE_OPENAI_ENDPOINT'] || '',
  new AzureKeyCredential(process.env['AZURE_OPENAI_API_KEY'] || ''),
);

const azureLlamaClient = new OpenAIClient(
  process.env['AZURE_LLAMA_ENDPOINT'] || '',
  new AzureKeyCredential(process.env['AZURE_LLAMA_API_KEY'] || ''),
);

const fireworksClient = new OpenAi({
  baseURL: 'https://api.fireworks.ai/inference/v1',
  apiKey: process.env['FIREWORKS_API_KEY'] || '',
  maxRetries: 3,
  timeout: 30 * 1000,
});

// Measure response time for LLM API calls
async function measureResponseTime(
  name: string,
  callFunction: () => Promise<void>,
) {
  const start = performance.now();
  await callFunction();
  const end = performance.now();
  console.log(`${name} took ${end - start} ms`);
}

async function callAnthropic(modelName: string) {
  try {
    await anthropic.messages.create({
      max_tokens: 150,
      temperature: 0,
      messages: [{ role: 'user', content: 'my heater is broken' }],
      model: modelName,
      system: SYSTEM_PROMPT,
    });
  } catch (error) {
    console.error('Error calling Anthropic:', error);
  }
}

async function callGroq(modelName: string) {
  try {
    const response = await groq.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'my heater is broken' },
      ],
      temperature: 0,
      max_tokens: 150,
      stream: true,
    });

    for await (const chunk of response) {
      process.stdout.write(chunk.choices[0].delta.content || '');
    }
    console.log();
  } catch (error) {
    console.error(`Error calling Groq with model ${modelName}:`, error);
  }
}

async function callOpenAI(modelName: string) {
  try {
    if (modelName.toLowerCase().includes('instruct')) {
      await openaiClient.completions.create({
        model: modelName,
        prompt: SYSTEM_PROMPT + 'my heater is broken',
        //   tool_choice: 'auto',
        //   tools: FUNCTION_TOOLS,
        temperature: 0,
        max_tokens: 150,
      });
    } else {
      await openaiClient.chat.completions.create({
        model: modelName,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 'my heater is broken' },
        ],
        //   tool_choice: 'auto',
        //   tools: FUNCTION_TOOLS,
        temperature: 0,
        max_tokens: 150,
      });
    }
  } catch (error) {
    console.error(`Error calling OpenAI with model ${modelName}:`, error);
  }
}

async function callAzureOpenAI(modelName: string) {
  try {
    if (modelName.toLowerCase().includes('llama')) {
      const message = await azureLlamaClient.getChatCompletions(
        modelName,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 'my heater is broken' },
        ],
        {
          maxTokens: 200,
          temperature: 0,
        },
      );
    } else {
      const message = await azureOpenaiClient.getChatCompletions(
        modelName,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 'my heater is broken' },
        ],
        {
          maxTokens: 200,
          temperature: 0,
        },
      );
    }
    // console.log(JSON.stringify(message));
  } catch (error) {
    console.error(`Error calling Azure with model ${modelName}:`, error);
  }
}

async function callFireworks(modelName: string) {
  try {
    const response = await fireworksClient.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'my heater is broken' },
      ],
      tool_choice: 'auto',
      tools: FUNCTION_TOOLS,
      temperature: 0,
      max_tokens: 150,
      stream: true,
    });
    for await (const chunk of response) {
      process.stdout.write(chunk.choices[0].delta.content || '');
    }
    console.log();
    // console.log(JSON.stringify(message));
  } catch (error) {
    console.error(`Error calling Fireworks with model ${modelName}:`, error);
  }
}

async function runBenchmark() {
  // const anthropicModels = [
  //   'claude-3-haiku-20240307',
  //   'claude-3-sonnet-20240229',
  //   'claude-3-opus-20240229',
  // ];
  // for (const modelName of anthropicModels) {
  //   await measureResponseTime(`Anthropic ${modelName}`, () =>
  //     callAnthropic(modelName),
  //   );
  // }
  const groqModels = ['llama3-70b-8192'];
  for (const modelName of groqModels) {
    await measureResponseTime(`Groq ${modelName}`, () => callGroq(modelName));
  }
  const fireworksModels = ['accounts/fireworks/models/llama-v3-70b-instruct'];
  for (const modelName of fireworksModels) {
    await measureResponseTime(`Fireworks ${modelName}`, () =>
      callFireworks(modelName),
    );
  }
  // const azureOpenaiModels = [
  //   'gpt-4-vision-preview',
  //   'Meta-Llama-3-70B-Instruct-wsdcs',
  //   'gpt-4-1106',
  //   'gpt-35-turbo',
  // ];
  // for (const modelName of azureOpenaiModels) {
  //   await measureResponseTime(`Azure ${modelName}`, () =>
  //     callAzureOpenAI(modelName),
  //   );
  // }
  const openaiModels = [
    'gpt-4-turbo-preview',
    'gpt-3.5-turbo',
    // 'gpt-3.5-turbo-instruct',
  ];
  for (const modelName of openaiModels) {
    await measureResponseTime(`OpenAI ${modelName}`, () =>
      callOpenAI(modelName),
    );
  }
}

runBenchmark();
