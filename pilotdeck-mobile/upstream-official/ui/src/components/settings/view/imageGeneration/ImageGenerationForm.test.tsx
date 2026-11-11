// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '../../../../i18n/locales/en/settings.json';
import zh from '../../../../i18n/locales/zh-CN/settings.json';
import { ImageGenerationForm } from './index';
import type { PilotDeckConfig } from '../modelPool/types';

const fetchImage = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/api', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  authenticatedFetch: fetchImage,
}));
vi.unmock('react-i18next');
vi.unmock('lucide-react');
afterEach(() => { cleanup(); fetchImage.mockReset(); });
const base = { agent: { model: 'test/model' }, model: { providers: {} } } as PilotDeckConfig;
const configured = (enabled = false): PilotDeckConfig => ({ ...base, tools: { imageGeneration: {
  enabled, apiKey: '********', baseUrl: 'https://images.example/v1', model: 'image-model',
} } });
async function form(config = configured(), change = vi.fn(), lng = 'zh-CN') {
  const i18n = createInstance();
  await i18n.init({ lng, defaultNS: 'settings', resources: { en: { settings: en }, 'zh-CN': { settings: zh } }, interpolation: { escapeValue: false } });
  const element = (next: PilotDeckConfig) => <I18nextProvider i18n={i18n}><ImageGenerationForm config={next} onChange={change} /></I18nextProvider>;
  const view = render(element(config));
  return { ...view, change, rerenderConfig: (next: PilotDeckConfig) => view.rerender(element(next)) };
}

it('defaults off, exposes editable fields without an edit button, and explains missing fields on enable', async () => {
  const { change } = await form(base);
  const toggle = screen.getByRole('switch');
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(toggle.hasAttribute('disabled')).toBe(false);
  expect(screen.getByLabelText('API 密钥').hasAttribute('disabled')).toBe(false);
  expect(screen.getByLabelText('API 地址').hasAttribute('disabled')).toBe(false);
  expect(screen.getByLabelText('模型名称').hasAttribute('disabled')).toBe(false);
  expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  expect(screen.queryByText(/默认关闭/)).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByText('请填写 API 密钥。')).toBeTruthy();
  expect(screen.getByText('请填写图像模型名称。')).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
});

it('saves directly edited fields while off and preserves the saved masked key', async () => {
  const { change } = await form();
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: ' another-model ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(change.mock.calls[0][0].tools.imageGeneration).toMatchObject({ enabled: false, apiKey: '********', model: 'another-model' });
});

it('enables the visible configuration and can always turn off despite an incomplete draft', async () => {
  const view = await form();
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'new-model' } });
  fireEvent.click(screen.getByRole('switch'));
  expect(view.change.mock.calls[0][0].tools.imageGeneration).toMatchObject({ enabled: true, model: 'new-model' });
  await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false));
  view.rerenderConfig(configured(true));
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('switch'));
  expect(view.change.mock.calls[1][0].tools.imageGeneration).toMatchObject({ enabled: false, model: 'image-model' });
  await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false));
  view.rerenderConfig(configured(false));
  expect((screen.getByLabelText('模型名称') as HTMLInputElement).value).toBe('');
});

it.each(['en', 'zh-CN'])('tests unsaved values while disabled and renders a real-image success in %s', async lng => {
  fetchImage.mockResolvedValue({ ok: true, json: async () => ({ ok: true, latencyMs: 1250 }) });
  const { change } = await form(configured(), vi.fn(), lng);
  fireEvent.change(screen.getByLabelText(lng === 'en' ? 'Model' : '模型名称'), { target: { value: 'draft-model' } });
  fireEvent.click(screen.getByRole('button', { name: lng === 'en' ? 'Test connection' : '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1.3'));
  expect(JSON.parse(fetchImage.mock.calls[0][1].body)).toMatchObject({ enabled: false, model: 'draft-model', apiKey: '********' });
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
});

it('requires a new key when changing address and allows testing new unsaved credentials', async () => {
  fetchImage.mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: 'HTTP 401: invalid key' }) });
  const { change } = await form();
  fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://other.example/v1' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect(screen.getByText('更换 API 地址后，请重新填写密钥。')).toBeTruthy();
  expect(fetchImage).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'new-key' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('HTTP 401'));
  expect(JSON.parse(fetchImage.mock.calls[0][1].body)).toMatchObject({ apiKey: 'new-key', baseUrl: 'https://other.example/v1' });
  expect(change).not.toHaveBeenCalled();
});

it('aborts an obsolete test and ignores its response after editing the configuration', async () => {
  let resolve!: (value: unknown) => void;
  fetchImage.mockImplementation(() => new Promise(done => { resolve = done; }));
  await form();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  const signal = fetchImage.mock.calls[0][1].signal;
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'different-model' } });
  expect(signal.aborted).toBe(true);
  resolve({ ok: true, json: async () => ({ ok: true, latencyMs: 1000 }) });
  await waitFor(() => expect(screen.getByRole('button', { name: '测试连接' }).hasAttribute('disabled')).toBe(false));
  expect(screen.getByRole('status').textContent).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect((screen.getByLabelText('模型名称') as HTMLInputElement).value).toBe('image-model');
});

const zhFallback = '测试失败：请检查地址、密钥和服务可用性。';
const enFallback = 'Test failed: Check the address, key, and service availability.';

it.each([
  ['zh-CN', '测试失败：API route not found: POST /api/image-generation/test'],
  ['en', 'Test failed: API route not found: POST /api/image-generation/test'],
])('renders the readable message of an object error in %s', async (lng, expected) => {
  fetchImage.mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: {
    code: 'API_ROUTE_NOT_FOUND', message: 'API route not found: POST /api/image-generation/test',
  } }) });
  await form(configured(), vi.fn(), lng);
  fireEvent.click(screen.getByRole('button', { name: lng === 'en' ? 'Test connection' : '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(expected));
  expect(screen.getByRole('status').textContent).not.toContain('[object Object]');
});

it('renders the readable message of an object error returned with HTTP 200 and ok=false', async () => {
  fetchImage.mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: {
    code: 'UPSTREAM_REJECTED', message: 'model image-model is not available',
  } }) });
  await form();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('model image-model is not available'));
  expect(screen.getByRole('status').textContent).not.toContain('[object Object]');
});

it.each([
  ['zh-CN', zhFallback],
  ['en', enFallback],
])('falls back to localized guidance in %s when the failure carries no readable reason', async (lng, expected) => {
  fetchImage.mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: {
    code: 'UPSTREAM_ERROR', detail: { apiKey: 'sk-SENTINEL-LEAK' },
  } }) });
  await form(configured(), vi.fn(), lng);
  fireEvent.click(screen.getByRole('button', { name: lng === 'en' ? 'Test connection' : '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(expected));
  expect(screen.getByRole('status').textContent).not.toContain('SENTINEL');
  expect(screen.getByRole('status').textContent).not.toContain('[object Object]');
});

it.each([
  ['missing', { ok: false }],
  ['null', { ok: false, error: null }],
  ['empty', { ok: false, error: '   ' }],
])('falls back to localized guidance when the failure error is %s', async (_label, body) => {
  fetchImage.mockResolvedValue({ ok: false, json: async () => body });
  await form();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zhFallback));
});

it('falls back to localized guidance when the response is not JSON', async () => {
  fetchImage.mockResolvedValue({ ok: false, json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } });
  await form();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zhFallback));
  expect(screen.getByRole('status').textContent).not.toContain('Unexpected token');
});

it('shows the network failure reason when the request never reaches the backend', async () => {
  fetchImage.mockRejectedValue(new TypeError('Failed to fetch'));
  await form();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('测试失败：Failed to fetch'));
});

it('renders the agent status message of an agent_status envelope', async () => {
  fetchImage.mockResolvedValue({ ok: false, json: async () => ({ agent_status: {
    type: 'agent_status', event: 'web_http_request_failed',
    detail: { message: '后端返回 404', userHint: 'Check the address and retry.' },
  } }) });
  await form();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('后端返回 404'));
  expect(screen.getByRole('status').textContent).toContain('Check the address and retry.');
});

it('falls back to localized guidance when an agent_status envelope carries no readable message', async () => {
  fetchImage.mockResolvedValue({ ok: false, json: async () => ({ agent_status: {
    type: 'agent_status', event: 'web_http_request_failed', detail: {},
  } }) });
  await form();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zhFallback));
  expect(screen.getByRole('status').textContent).not.toContain('Request failed');
});

it('prefers the readable error over an agent_status envelope without a readable message', async () => {
  fetchImage.mockResolvedValue({ ok: false, json: async () => ({
    agent_status: { type: 'agent_status', event: 'web_http_request_failed', detail: {} },
    error: { message: 'plain readable reason' },
  }) });
  await form();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('测试失败：plain readable reason'));
});

it('keeps the newest status when an obsolete failure response arrives late', async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  fetchImage.mockImplementation(() => new Promise(done => { resolvers.push(done); }));
  await form();
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'fresh-model' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await act(async () => { resolvers[0]({ ok: false, json: async () => ({ ok: false, error: { message: 'obsolete failure' } }) }); });
  expect(screen.getByRole('status').textContent).toBe('');
  await act(async () => { resolvers[1]({ ok: true, json: async () => ({ ok: true, latencyMs: 1000 }) }); });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1.0'));
  expect(screen.getByRole('status').textContent).not.toContain('obsolete failure');
});
