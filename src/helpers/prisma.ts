// lib/prisma.ts
import { PrismaClient } from '@prisma/client';
import { JsonObject } from '@prisma/client/runtime/library';
import OpenAi from 'openai';

let prismaClient: PrismaClient;

if (process.env.NODE_ENV === 'production') {
  prismaClient = new PrismaClient();
} else {
  // In non-production, reuse PrismaClient instance to avoid multiple instances due to hot reloading.
  if (!(global as any).prisma) {
    (global as any).prisma = new PrismaClient();
  }
  prismaClient = (global as any).prisma;
}

async function getModelParamsFromDB(dbCallId: string | null) {
  const result = await prismaClient.call.findFirst({
    where: {
      id: dbCallId || '',
    },
    select: {
      agent_configuration: {
        where: {
          active_config: true,
        },
        select: {
          system_prompt: true,
          llm_model: true,
          function_calls: true,
          intro_message: true,
          prompt_variables: true,
        },
      },
    },
  });
  const SYSTEM_PROMPT_TEMPLATE =
    result!.agent_configuration!.system_prompt || '';
  const FUNCTION_TOOLS: OpenAi.Chat.Completions.ChatCompletionTool[] = result!
    .agent_configuration!
    .function_calls! as unknown as OpenAi.Chat.Completions.ChatCompletionTool[];
  const INTRO_MESSAGE_TEMPLATE =
    result?.agent_configuration?.intro_message || "Hey, how's it going?";
  const PROMPT_VARIABLES = result!.agent_configuration!
    .prompt_variables as JsonObject;
  const LLM_MODEL = result!.agent_configuration!.llm_model || 'gpt-3.5-turbo';
  let INTRO_MESSAGE = '';
  let SYSTEM_PROMPT = '';

  if (PROMPT_VARIABLES && Object.keys(PROMPT_VARIABLES).length > 0) {
    console.log('Building dynamic prompts!');
    INTRO_MESSAGE = INTRO_MESSAGE_TEMPLATE.replace(
      /{(\w+)}/g,
      (match, variable) =>
        (PROMPT_VARIABLES as JsonObject)[variable]?.toString() || match,
    );
    SYSTEM_PROMPT = SYSTEM_PROMPT_TEMPLATE.replace(
      /{(\w+)}/g,
      (match, variable) =>
        (PROMPT_VARIABLES as JsonObject)[variable]?.toString() || match,
    );
  } else {
    INTRO_MESSAGE = INTRO_MESSAGE_TEMPLATE;
    SYSTEM_PROMPT = SYSTEM_PROMPT_TEMPLATE;
  }

  return {
    introMessage: INTRO_MESSAGE,
    systemPrompt: SYSTEM_PROMPT,
    functionTools: FUNCTION_TOOLS,
    modelName: LLM_MODEL,
  };
}

// Named export of the function
export { getModelParamsFromDB as getModelParametersFromDB };

// Default export of the prismaClient
export default prismaClient;

// let dbCallId: string | null;
// dbCallId = 'c6d7855c-fe18-4cba-9569-1c751f8a4dda';

// const result = await getModelParamsFromDB(dbCallId);
// console.log(result);
