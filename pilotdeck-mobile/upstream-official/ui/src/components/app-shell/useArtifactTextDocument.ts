import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchArtifactText, saveArtifactText, type ArtifactTextDelta } from './artifactText';

/**
 * 成果台文档的加载／保存生命周期。
 *
 * 刻意照着 code-editor 的 useCodeEditorDocument 写：脏状态、保存中、失败提示
 * 各占一个 state，加载失败时缓冲区保持干净、保存按钮直接拒绝。两边规则必须一样 ——
 * 成果台这份副本是评审手上唯一的版本，一句错误提示被写回去就等于把成果清了。
 * 不同的只有落点：项目文件写回项目，成果台写回成果台自己的副本。
 */
export function useArtifactTextDocument(artifactId: string) {
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [delta, setDelta] = useState<ArtifactTextDelta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  // 保存成功的提示要自己收掉，不然「已保存」会一直挂在编辑区顶上，
  // 看着像刚保存过。定时器跟着换文档／卸载走，免得给下一份成果误报。
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    void fetchArtifactText(artifactId, controller.signal).then(text => {
      if (cancelled) return;
      setContent(text.text);
      setSavedContent(text.text);
      setDelta(text.delta);
    }).catch(cause => {
      if (cancelled || controller.signal.aborted) return;
      // 错误绝不进 content：这个缓冲区会被原样 PUT 回去。
      setLoadError(cause instanceof Error ? cause.message : '正文读取失败');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; controller.abort(); };
  }, [artifactId, reloadToken]);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const reload = useCallback(() => setReloadToken(token => token + 1), []);

  /** 返回是否真的存进去了：调用方要靠它决定「保存后顺便退出」能不能做。 */
  const handleSave = useCallback(async (): Promise<boolean> => {
    // 没读到过正文就不让保存：那时的缓冲区是空的或半截的，
    // 写回去等于把成果台副本清成一句话。
    if (loading || loadError) {
      setSaveError('正文还没读出来，不能保存');
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await saveArtifactText(artifactId, content);
      setSavedContent(content);
      setDelta(result.delta);
      setSavedAt(Date.now());
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedAt(0), 3000);
      return true;
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : '保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  }, [artifactId, content, loadError, loading]);

  return {
    content,
    setContent,
    loading,
    loadError,
    reload,
    saving,
    saveError,
    savedAt,
    delta,
    isDirty: !loading && !loadError && content !== savedContent,
    handleSave,
  };
}
