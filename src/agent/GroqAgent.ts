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
// const FUNCTION_TOOLS: OpenAi.Chat.Completions.ChatCompletionTool[] = result!
//   .agent_configuration!
//   .function_calls! as unknown as OpenAi.Chat.Completions.ChatCompletionTool[];

const groq = new Groq({
  apiKey: process.env['GROQ_API_KEY'],
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

async function generateChatMessage(modelName: string) {
  try {
    await groq.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'my heater is broken' },
      ],
      temperature: 0,
      max_tokens: 150,
    });
  } catch (error) {
    console.error(`Error calling Groq with model ${modelName}:`, error);
  }
}

async function streamChatMessage(modelName: string = 'llama3-70b-8192') {
  try {
    await groq.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'my heater is broken' },
      ],
      temperature: 0,
      max_tokens: 150,
    });
  } catch (error) {
    console.error(`Error calling Groq with model ${modelName}:`, error);
  }
}

const groqModels = ['llama3-70b-8192', 'llama3-8b-8192'];
for (const modelName of groqModels) {
  await measureResponseTime(`Groq ${modelName}`, () =>
    generateChatMessage(modelName),
  );
}
