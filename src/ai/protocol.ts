export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Rpc = { jsonrpc: '2.0'; id?: number; method?: string; params?: Json; result?: Json; error?: { message: string } };
export type CodexEvent = { generation: number; message: Rpc };
