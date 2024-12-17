import prismaClient from '../helpers/prisma.js';
import { CallCategory, CallStatus } from '../types/call.js';

async function update_call_lead(
  leadDetails: {
    call_reason: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone_number?: string;
    address?: string;
    postal_code?: string;
  },
  callId: string,
): Promise<void> {
  const category =
    leadDetails.first_name && leadDetails.last_name && leadDetails.email
      ? CallCategory.PROPOSED_BOOKING
      : CallCategory.OTHER;

  await prismaClient.call.update({
    where: { id: callId },
    data: {
      call_reason: leadDetails.call_reason,
      ...(leadDetails.first_name && { first_name: leadDetails.first_name }),
      ...(leadDetails.last_name && { last_name: leadDetails.last_name }),
      ...(leadDetails.email && { email: leadDetails.email }),
      ...(leadDetails.phone_number && {
        phone_number: leadDetails.phone_number,
      }),
      ...(leadDetails.address && { address: leadDetails.address }),
      ...(leadDetails.postal_code && {
        postal_code: leadDetails.postal_code,
      }),
      category: category,
      status: CallStatus.PENDING_REVIEW,
    },
  });
}

async function end_call(callId: string): Promise<void> {
  const call = await prismaClient.call.findUnique({
    where: { id: callId },
  });

  if (call) {
    await prismaClient.call.update({
      where: { id: callId },
      data: {
        status: CallStatus.PENDING_REVIEW,
        category:
          call.category === CallCategory.BUG
            ? CallCategory.OTHER
            : call.category,
      },
    });
  }
}

export { end_call, update_call_lead };
