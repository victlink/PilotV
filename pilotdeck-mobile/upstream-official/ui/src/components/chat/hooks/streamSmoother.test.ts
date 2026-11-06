import { describe, expect, it, vi } from 'vitest';
import { SmoothTextStream } from './streamSmoother';

function createManualFrameScheduler(onFrame?: () => void) {
  let nextId = 1;
  const queue: Array<{ id: number; callback: () => void; cancelled: boolean }> = [];

  return {
    scheduleFrame(callback: () => void): number {
      const id = nextId;
      nextId += 1;
      queue.push({ id, callback, cancelled: false });
      return id;
    },
    cancelFrame(id: number) {
      const item = queue.find((entry) => entry.id === id);
      if (item) item.cancelled = true;
    },
    runNext() {
      const item = queue.shift();
      if (item && !item.cancelled) {
        onFrame?.();
        item.callback();
      }
    },
    drain(limit = 80) {
      let count = 0;
      while (queue.length > 0 && count < limit) {
        this.runNext();
        count += 1;
      }
      return count;
    },
    get size() {
      return queue.filter((item) => !item.cancelled).length;
    },
  };
}

describe('SmoothTextStream', () => {
  it('renders a large chunk over many bounded frame updates', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    const text = 'abcdefghijklmnopqrstuvwxyz '.repeat(8);
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
      frameMs: 33,
      minCharsPerFrame: 3,
      maxCharsPerFrame: 18,
    });

    stream.append(text);

    // 首帧不再同步吐字：append 只排一次泵，内容在下一帧才出来。
    expect(emitted.length).toBe(0);
    expect(stream.getSnapshot().targetLength).toBe(text.length);

    scheduler.runNext();
    scheduler.runNext();

    expect(emitted.length).toBe(2);
    expect(emitted[0].length).toBeGreaterThan(0);
    expect(emitted[0].length).toBeLessThan(text.length);

    for (let index = 1; index < emitted.length; index += 1) {
      const delta = emitted[index].length - emitted[index - 1].length;
      expect(delta).toBe(2);
    }

    // 216 个字符、每帧 2 个字符，需要 108 帧。
    scheduler.drain(200);

    expect(emitted[emitted.length - 1]).toBe(text);
    expect(stream.getSnapshot().renderedLength).toBe(text.length);
  });

  it('keeps a constant render rate regardless of chunk cadence', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const stream = new SmoothTextStream({
      emit: () => {},
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
    });

    stream.append('abcd');
    now += 40;
    stream.append('x'.repeat(80));

    // 平滑器已经不做自适应速率了：恒定 120 字/秒，每帧固定 2 个字符。
    const snapshot = stream.getSnapshot();
    expect(snapshot.averageCharsPerSecond).toBe(120);
    expect(snapshot.pendingChars).toBe(84);

    scheduler.runNext();

    const afterFrame = stream.getSnapshot();
    expect(afterFrame.averageCharsPerSecond).toBe(120);
    expect(afterFrame.pendingChars).toBe(82);
  });

  it('renders a fixed number of characters per frame', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
      frameMs: 16,
      minCharsPerFrame: 6,
      maxCharsPerFrame: 12,
    });

    stream.append('hello world, next sentence.');
    scheduler.runNext();

    // frameMs / minCharsPerFrame / maxCharsPerFrame 被接收但不再参与计算，
    // 也不会在空白或标点处断句。
    expect(emitted[0]).toBe('he');
    expect(emitted[0].length).toBe(2);
  });

  it('flushes all buffered content and finalizes immediately', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    let finalized = 0;
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      finalize: () => {
        finalized += 1;
      },
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
    });

    stream.append('streaming output');
    stream.flush(true);

    expect(emitted.at(-1)).toBe('streaming output');
    expect(finalized).toBe(1);
    expect(stream.getSnapshot().targetLength).toBe(0);
    expect(stream.getSnapshot().renderedLength).toBe(0);
    expect(scheduler.size).toBe(0);
  });

  it('falls back to a timer when the scheduled frame does not run promptly', () => {
    vi.useFakeTimers();
    const requestAnimationFrameSpy = vi.fn(() => 1);
    const cancelAnimationFrameSpy = vi.fn();
    vi.stubGlobal('window', {
      requestAnimationFrame: requestAnimationFrameSpy,
      cancelAnimationFrame: cancelAnimationFrameSpy,
      setTimeout: globalThis.setTimeout,
      // 没有 clearTimeout 的话，兜底计时器触发时会直接抛异常。
      clearTimeout: globalThis.clearTimeout,
    });
    const emitted: string[] = [];

    try {
      const stream = new SmoothTextStream({
        emit: (content) => emitted.push(content),
        fallbackFrameMs: 10,
      });

      stream.append('abcdefghijklmnopqrstuvwxyz '.repeat(4));

      // 首帧同样是等调度，不同步吐字。
      expect(emitted.length).toBe(0);

      vi.advanceTimersByTime(10);

      // 16ms 的帧计时器还没到，10ms 的兜底计时器先把内容推出来。
      expect(emitted.length).toBe(1);
      expect(emitted[0]).toBe('ab');

      vi.advanceTimersByTime(16);

      expect(emitted.length).toBe(2);
      expect(emitted[1]).toBe('abcd');

      // 调度走的是 setTimeout，从头到尾没用过 requestAnimationFrame。
      expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
      expect(cancelAnimationFrameSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
