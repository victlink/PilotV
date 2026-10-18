import { afterEach, expect, it, vi } from 'vitest';
import { describeDelta, fetchArtifactText, saveArtifactText } from './artifactText';

afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

it('reads the console copy of the body and normalizes the changed-lines report', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    artifact_id: 'a1', text: '# 标题\n', bytes: 10,
    changed: { edited: true, added: 3, removed: 1, diff: '@@', truncated: false },
  }));
  vi.stubGlobal('fetch', fetchMock);

  const text = await fetchArtifactText('a1');
  expect(fetchMock).toHaveBeenCalledWith('/api/artifacts/a1/text', undefined);
  expect(text).toMatchObject({ artifactId: 'a1', text: '# 标题\n', bytes: 10 });
  expect(text.delta).toMatchObject({ edited: true, added: 3, removed: 1 });
  expect(describeDelta(text.delta)).toBe('已改 +3 / −1 行');
});

it('escapes ids and never turns a missing body into the string "undefined"', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ artifact_id: 'a/b' })));

  const text = await fetchArtifactText('a/b', new AbortController().signal);
  expect(fetch).toHaveBeenCalledWith('/api/artifacts/a%2Fb/text', expect.anything());
  expect(text.text).toBe('');
  expect(text.delta.edited).toBe(false);
  expect(describeDelta(text.delta)).toBe('');
});

it('puts the body back to the console copy, not to the project', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
    ok: true, artifact_id: 'a1', bytes: 12, changed: { edited: true, added: 1, removed: 0 },
  }));
  vi.stubGlobal('fetch', fetchMock);

  const saved = await saveArtifactText('a1', '<p>hi</p>');
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('/api/artifacts/a1/text');
  expect(init.method).toBe('PUT');
  expect(JSON.parse(String(init.body))).toEqual({ text: '<p>hi</p>' });
  expect(saved.bytes).toBe(12);
});

// 状态码本身用户接不住：415 意味着「这不是能改的文本」，413 意味着「太长」，
// 说清楚比把数字甩出来有用。415 那条要盖住两种情况：类型不在清单里、以及文件
// 本身已经超过 2MB —— 后端 editable_reason 把它们归成同一个结果。
it('turns 404 / 415 / 413 into something a reader can act on', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 415)));
  await expect(fetchArtifactText('a1')).rejects.toThrow('不在成果台可编辑的范围里');

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)));
  await expect(fetchArtifactText('a1')).rejects.toThrow('没有可编辑的源文件');

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 413)));
  await expect(saveArtifactText('a1', 'x')).rejects.toThrow('2MB');
});

// 服务端自己的话最准（空正文是 400 且带明确理由），不能被通用提示盖掉。
it('prefers the server wording over the status hint', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: '内容是空的，没有保存' }, 400)));

  await expect(saveArtifactText('a1', ' ')).rejects.toThrow('内容是空的，没有保存');
});

// 中间有代理插了一页 HTML 时不该把整页塞进提示里，退回状态码即可。
it('falls back to the status when the error body is not JSON', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status: 502,
    json: async () => { throw new Error('not json'); },
  }));

  await expect(fetchArtifactText('a1')).rejects.toThrow('正文读取失败：HTTP 502');
});
