import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouterRuntime } from './RouterRuntime.js';
import type { ModelRuntime } from '../model/index.js';

test('explicit fixed target cannot drift into configured fallback on error', async () => {
  const seen: string[] = [];
  const router = createRouterRuntime({ enabled: true, fallback: { explicit: [{ id: 'p/other', provider: 'p', model: 'other' }] } }, { modelRuntime: {
    getCapabilities: () => ({}), getMultimodal: () => undefined,
    async *stream(request: { model: string }) { seen.push(request.model); yield { type: 'error', error: { code: 'server_error', message: 'failed', retryable: true } }; },
  } as unknown as ModelRuntime });
  try {
    for await (const _ of router.execute({ provider: 'p', model: 'fixed', scenarioType: 'explicit', isSubagent: true, orchestrating: false, resolvedFrom: 'explicit', mutations: {} }, { provider: 'p', model: 'fixed', messages: [], stream: true }, { sessionId: 's', turnId: 't' })) {}
    assert.deepEqual(seen, ['fixed']);
  } finally { await router.shutdown(); }
});

for (const scenario of ['selected', 'disabled', 'empty', 'incapable', 'fallback'] as const) {
  test(`project Auto pool: ${scenario}`, async () => {
    let judged = 0;
    const runtime = {
      getCapabilities: () => ({ supportsToolUse: scenario !== 'incapable', supportsStreaming: true, supportsSystemPrompt: true, maxContextTokens: 32000, maxOutputTokens: 4000 }),
      async complete() { judged++; return { content: [{ type: 'text', text: scenario === 'fallback' ? '' : 'simple' }] }; },
    } as unknown as ModelRuntime;
    const router = createRouterRuntime({ enabled: scenario !== 'disabled', tokenSaver: {
      enabled: true, judge: { id: 'p/judge', provider: 'p', model: 'judge' }, defaultTier: 'simple', judgeTimeoutMs: 500,
      tiers: { simple: { model: { id: 'p/small', provider: 'p', model: 'small' } } },
    } }, { modelRuntime: runtime, modelConfig: { providers: { p: { apiKey: scenario === 'empty' ? '' : 'fixture-key', models: { small: {} } } } } as never });
    try {
      if (['disabled', 'empty', 'incapable'].includes(scenario)) {
        await assert.rejects(() => router.resolveProjectTaskModel!({ directive: 'Inspect a file', sessionId: 's' }), /AUTO_.*UNAVAILABLE|AUTO_NO_CANDIDATE/);
        assert.equal(judged, 0);
      } else {
        const result = await router.resolveProjectTaskModel!({ directive: 'Inspect a file', sessionId: 's' });
        assert.deepEqual(result.model, { provider: 'p', model: 'small' });
        assert.equal(result.difficulty, 'simple');
        assert.match(result.reason, scenario === 'fallback' ? /fallback.*parse_error/ : /judge/);
      }
    } finally { await router.shutdown(); }
  });
}
