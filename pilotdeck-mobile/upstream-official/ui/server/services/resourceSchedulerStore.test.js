import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    archiveTask,
    deleteTask,
    fromStoredTask,
    getTaskmasterDir,
    readTaskRecords,
    saveTask,
    taskmasterFileName,
    toStoredTask,
} from './resourceSchedulerStore.js';

function tempHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-taskmaster-'));
}

describe('调度器账本', () => {
    it('文件名带 hash 后缀，sanitize 后同名也不会撞车', () => {
        const a = taskmasterFileName('web:s_1');
        const b = taskmasterFileName('web-s_1');
        expect(a).not.toBe(b);
    });

    it('原子写入后可读回', () => {
        const home = tempHome();
        const task = {
            id: 'web-s_1',
            sessionKey: 'web-s_1',
            goal: '测试任务',
            status: 'queued',
            priority: 3,
        };
        saveTask(task, { home });
        const { pending } = readTaskRecords({ home });
        expect(pending).toHaveLength(1);
        expect(pending[0].goal).toBe('测试任务');
        expect(pending[0].priority).toBe(3);
    });

    it('坏文件被改名留证，不会静默删除', () => {
        const home = tempHome();
        const dir = getTaskmasterDir(home);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf8');
        const { corrupted, pending } = readTaskRecords({ home });
        expect(corrupted).toHaveLength(1);
        expect(pending).toHaveLength(0);
        const names = fs.readdirSync(dir);
        expect(names.some((name) => name.startsWith('broken.json.bad-'))).toBe(true);
    });

    it('归档先写历史再删账本', () => {
        const home = tempHome();
        const task = { id: 'web-s_1', sessionKey: 'web-s_1', status: 'running', goal: 'x' };
        saveTask(task, { home });
        archiveTask(task, { home, status: 'done', reason: 'finished' });
        const { pending } = readTaskRecords({ home });
        expect(pending).toHaveLength(0);
        const history = fs.readFileSync(path.join(getTaskmasterDir(home), 'history.jsonl'), 'utf8');
        expect(history).toContain('finished');
    });

    it('暂停态的任务仍留在账本里（不会被当成结束）', () => {
        const home = tempHome();
        const task = { id: 'web-s_1', sessionKey: 'web-s_1', status: 'paused', goal: 'x' };
        saveTask(task, { home });
        const { pending } = readTaskRecords({ home });
        expect(pending).toHaveLength(1);
        expect(pending[0].status).toBe('paused');
    });

    it('已结束的账本会被清理掉', () => {
        const home = tempHome();
        const task = { id: 'web-s_1', sessionKey: 'web-s_1', status: 'done', goal: 'x' };
        saveTask(task, { home });
        const { finished } = readTaskRecords({ home });
        expect(finished).toHaveLength(1);
    });

    it('内存任务与账本记录互转（纯函数）', () => {
        const task = {
            id: 'a',
            sessionKey: 'a',
            goal: '目标',
            status: 'paused',
            pauseCount: 2,
            resumeAt: 123,
            resumeHint: '换个做法',
            cost: { ramMb: 512, cpuWeight: 1 },
        };
        const record = toStoredTask(task, { now: 999 });
        expect(record.pauseCount).toBe(2);
        expect(record.resumeAt).toBe(123);
        const restored = fromStoredTask(record);
        expect(restored.resumeHint).toBe('换个做法');
        expect(restored.cost.ramMb).toBe(512);
    });

    it('删除账本不写历史', () => {
        const home = tempHome();
        saveTask({ id: 'a', sessionKey: 'a', status: 'queued' }, { home });
        deleteTask('a', { home });
        const { pending } = readTaskRecords({ home });
        expect(pending).toHaveLength(0);
        const historyPath = path.join(getTaskmasterDir(home), 'history.jsonl');
        expect(fs.existsSync(historyPath)).toBe(false);
    });
});
