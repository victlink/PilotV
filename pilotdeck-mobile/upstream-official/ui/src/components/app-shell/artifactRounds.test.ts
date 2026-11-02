import { expect, it } from 'vitest';
import { finalArtifacts } from './artifactRounds';
import type { Artifact } from './artifactsMedia';

const art = (id: string, ts: string | null, extra: Partial<Artifact> = {}): Artifact =>
  ({ id, run_id: 's1', ts, ...extra }) as Artifact;

it('keeps only the last artifact of each publishing round', () => {
  // 接口给的是新→旧；同一秒就是一「轮」发布，最后发布的那份排在同批末尾。
  const items = [
    art('round2-final', '2026-10-16T19:26:25Z'),
    art('round2-draft', '2026-10-16T19:26:25Z'),
    art('round1-final', '2026-10-16T18:00:07Z'),
    art('round1-draft', '2026-10-16T18:00:07Z'),
  ];
  expect(finalArtifacts(items).map(item => item.id)).toEqual(['round2-final', 'round1-final']);
});

it('does not merge rounds of different sessions', () => {
  const items = [
    art('a1', '2026-10-16T19:26:25Z', { run_id: 's1' }),
    art('b1', '2026-10-16T19:26:25Z', { run_id: 's2' }),
  ];
  expect(finalArtifacts(items)).toHaveLength(2);
});

it('keeps a whole declared comparison group', () => {
  const items = [
    art('variant-c', '2026-10-16T19:26:25Z', { entry: { meta: { compare_group: 'logo' } } }),
    art('variant-b', '2026-10-16T19:26:25Z', { entry: { meta: { compare_group: 'logo' } } }),
    art('draft-of-b', '2026-10-16T19:26:25Z'),
  ];
  // 三个都在同一轮：对比组的两份都留着，普通那份仍然只留最后一个。
  expect(finalArtifacts(items).map(item => item.id)).toEqual(['variant-c', 'variant-b', 'draft-of-b']);
});

it('keeps every member of a comparison group spread over several rounds', () => {
  const items = [
    art('v1', '2026-10-16T18:00:07Z', { entry: { meta: { compare_group: 'palette' } } }),
    art('v2', '2026-10-16T19:26:25Z', { entry: { meta: { compare_group: 'palette' } } }),
    art('other', '2026-10-16T19:26:25Z'),
  ];
  expect(finalArtifacts(items).map(item => item.id)).toEqual(['v1', 'v2', 'other']);
});

it('treats blank or non-string compare_group as no declaration at all', () => {
  const items = [
    art('x', '2026-10-16T19:26:25Z', { entry: { meta: { compare_group: '   ' } } }),
    art('y', '2026-10-16T19:26:25Z', { entry: { meta: { compare_group: 7 } } }),
  ];
  // 声明无效 = 不是对比组，于是走「每轮留最后一份」，同秒里最后发布的在最前面。
  expect(finalArtifacts(items).map(item => item.id)).toEqual(['x']);
});

it('keeps artifacts without a timestamp instead of swallowing them', () => {
  const items = [art('legacy-1', null), art('legacy-2', null)];
  expect(finalArtifacts(items)).toHaveLength(2);
});

it('is a no-op on a list that already holds one artifact per round', () => {
  const items = [art('b', '2026-10-16T19:26:25Z'), art('a', '2026-10-16T18:00:07Z')];
  expect(finalArtifacts(items)).toEqual(items);
});

it('returns nothing for an empty list', () => {
  expect(finalArtifacts([])).toEqual([]);
});
