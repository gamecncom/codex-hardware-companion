import { QwenAsr } from './qwen-asr.js';
/** Production selects an explicit provider; no fake provider is selected by default. */
export interface AsrAdapter { readonly kind:string; transcribe(filePath:string):Promise<{transcript:string;providerTaskId?:string}> }
export class TestAsrAdapter implements AsrAdapter {
  readonly kind='test-adapter';
  async transcribe(_filePath:string){return {transcript:'[TEST ASR] transcript supplied by fixture',providerTaskId:'test-asr-'+Date.now()};}
}
export function createAsrAdapter(env=process.env):AsrAdapter {
  if(env.NODE_ENV==='test'&&env.ASR_PROVIDER==='test') return new TestAsrAdapter();
  if(env.ASR_PROVIDER==='qwen') {
    if(!env.DASHSCOPE_API_KEY?.trim()) throw new Error('DASHSCOPE_API_KEY is required for Qwen ASR');
    return new QwenAsr({ apiKey: env.DASHSCOPE_API_KEY,
      model: env.DASHSCOPE_ASR_MODEL ?? 'qwen3-asr-flash-filetrans',
      baseURL: env.DASHSCOPE_BASE_URL ?? 'https://dashscope.aliyuncs.com',
      pollIntervalMs: 1000, maxPolls: 120 });
  }
  throw new Error('ASR provider is not configured; production cannot use a fake adapter');
}
