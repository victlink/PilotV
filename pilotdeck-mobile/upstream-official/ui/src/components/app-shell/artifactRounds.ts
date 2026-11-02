import { compareGroup, type Artifact } from './artifactsMedia';

/**
 * 成果列表默认只给看每轮的最终结果，中间过程直接收起来（不是加开关藏起来）。
 *
 * 「一轮」在数据里就是同一秒的发布：成果台的 ts 只有秒级精度，一个 agent
 * 收尾时一口气发的那几份（草稿、预览、切片、成品）都落在同一秒。
 *
 * 依赖服务端的一个真实契约：/api/artifacts/workspace 走 artifacts_store.list()，
 * 那里的 SQL 是 `ORDER BY ts DESC, rowid DESC`。rowid 随插入递增，所以同一秒里
 * **最后发布的那份排在最前面**。因此每批只留「第一个遇到的」才是最后发布的那份 ——
 * 留最后一个等于留草稿。（改动 artifacts_store.py 的排序时要回来同步这里。）
 *
 * 两种例外：
 *   - 发布时声明了同一个 compare_group：这是刻意做的多结果对比（几个 logo 方向、
 *     三套配色），收成一份等于把对比抹掉，所以整组都留着，跨批次也算一组。
 *   - 没有 ts 的老成果：无法判断批次，宁可留着，也不让它凭空消失。
 */
export function finalArtifacts(items: readonly Artifact[]): Artifact[] {
  const seenBatch = new Set<string>();
  const keep = new Set<string>();

  for (const item of items) {
    if (compareGroup(item) || !item.ts) {
      keep.add(item.id);
      continue;
    }
    const batch = `${item.run_id || ''}^@${item.ts}`;
    if (seenBatch.has(batch)) continue;   // 同一轮里更早遇到的才是最后发布的那份
    seenBatch.add(batch);
    keep.add(item.id);
  }
  return items.filter(item => keep.has(item.id));
}
