export interface RetellRequest {
  response_id?: number;
  transcript: Message[];
  interaction_type: 'update_only' | 'response_required' | 'reminder_required';
}

export interface RetellResponse {
  response_id: number;
  content: string;
  content_complete: boolean;
  end_call: boolean;
} //////////////////////////////////// types

export interface Message {
  // agent is a label used/created by Retell
  role: 'user' | 'assistant' | 'system' | 'tool' | 'function' | 'agent';
  content: string | null;
  name?: string | null;
  tool_call_id?: string | null;
}
