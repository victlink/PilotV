import { useEffect, useState } from 'react';

/**
 * Manual pinning for sidebar projects and conversations.
 *
 * Same idea as `customNames`: nothing here is sent to the server. The
 * backend has no concept of "pinned", so the list of pinned keys lives in
 * this browser's localStorage and the sidebar re-sorts on top of whatever
 * order the projects API returned. Session keys are namespaced by project
 * because the same session id can never collide across projects, but the
 * composite keeps the stored map readable and lets a project be renamed on
 * disk without dragging its pinned conversations along.
 */

const STORAGE_KEY = 'pilotdeck:pinnedItems';
const CHANGE_EVENT = 'pinneditems:changed';

export type PinnedItems = {
  projects: string[];
  sessions: string[];
};

const EMPTY: PinnedItems = { projects: [], sessions: [] };

export function sessionPinKey(projectName: string, sessionId: string): string {
  return `${projectName}::${sessionId}`;
}

function readPinnedItems(): PinnedItems {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<PinnedItems> | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
    return { projects: strings(parsed.projects), sessions: strings(parsed.sessions) };
  } catch {
    return EMPTY;
  }
}

function writePinnedItems(next: PinnedItems): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Unusable storage just means pins do not survive a reload.
  }
  // `storage` only fires in other tabs, so same-tab listeners need this one.
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function toggle(key: string, list: string[]): string[] {
  return list.includes(key) ? list.filter(entry => entry !== key) : [...list, key];
}

export function toggleProjectPin(projectName: string): void {
  const current = readPinnedItems();
  writePinnedItems({ ...current, projects: toggle(projectName, current.projects) });
}

export function toggleSessionPin(projectName: string, sessionId: string): void {
  const current = readPinnedItems();
  writePinnedItems({ ...current, sessions: toggle(sessionPinKey(projectName, sessionId), current.sessions) });
}

// Set lookups keep the sidebar sort O(n) instead of scanning an array per row.
export function pinnedProjectSet(pinned: PinnedItems): Set<string> {
  return new Set(pinned.projects);
}

export function pinnedSessionSet(pinned: PinnedItems): Set<string> {
  return new Set(pinned.sessions);
}

export function usePinnedItems(): PinnedItems {
  const [items, setItems] = useState<PinnedItems>(readPinnedItems);

  useEffect(() => {
    const refresh = () => { setItems(readPinnedItems()); };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return items;
}