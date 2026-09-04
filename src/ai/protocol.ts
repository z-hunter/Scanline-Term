export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Rpc = { jsonrpc: '2.0'; id?: number; method?: string; params?: Json; result?: Json; error?: { message: string } };
export type CodexEvent = { generation: number; message: Rpc };

export type CodexReasoningEffort = {
  reasoningEffort: string;
  description?: string;
};

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  hidden?: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
  isDefault?: boolean;
};

export type CodexModelList = { data: CodexModel[]; nextCursor?: string | null };
