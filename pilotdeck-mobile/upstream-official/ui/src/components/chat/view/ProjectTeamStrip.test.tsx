// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import enChat from '../../i18n/locales/en/chat.json';
import enProjectTeam from '../../i18n/locales/en/projectTeam.json';
import zhChat from '../../i18n/locales/zh-CN/chat.json';
import zhProjectTeam from '../../i18n/locales/zh-CN/projectTeam.json';
import { collectSpeakers, type SpeakerEntry } from './agentIdentity';
import ProjectTeamStrip from './ProjectTeamStrip';

type Language = 'zh-CN' | 'en';

const RESOURCES: Record<string, Record<string, Record<string, unknown>>> = {
  en: { chat: enChat, projectTeam: enProjectTeam },
  'zh-CN': { chat: zhChat, projectTeam: zhProjectTeam },
};

/** 主 agent + 指挥 + 审查：三种角色，三套图标。 */
const SPEAKERS: SpeakerEntry[] = collectSpeakers({
  agents: [
    { id: 'agent-commander', name: '阿强', role: 'commander' },
    { id: 'agent-reviewer', name: '小林', role: 'reviewer' },
  ],
  messages: [
    { agentName: '阿强', agentRole: 'commander' },
    { agentName: '小林', agentRole: 'reviewer' },
  ],
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderStrip(
  props: {
    speakers?: SpeakerEntry[];
    activeSpeakerKey?: string | null;
    onSelectSpeaker?: (key: string | null) => void;
  } = {},
  language: Language = 'zh-CN',
) {
  const instance = createInstance();
  await instance.init({
    lng: language,
    fallbackLng: 'en',
    defaultNS: 'chat',
    ns: ['chat', 'projectTeam'],
    resources: RESOURCES,
    interpolation: { escapeValue: false },
  });
  const onSelectSpeaker = props.onSelectSpeaker ?? vi.fn();
  const view = render(
    <I18nextProvider i18n={instance}>
      <ProjectTeamStrip
        speakers={props.speakers ?? SPEAKERS}
        activeSpeakerKey={props.activeSpeakerKey ?? null}
        onSelectSpeaker={onSelectSpeaker}
      />
    </I18nextProvider>,
  );
  return { ...view, onSelectSpeaker, i18n: instance };
}

function speakerButton(container: HTMLElement, key: string): HTMLElement {
  const button = container.querySelector<HTMLElement>(`[data-speaker-key="${key}"]`);
  if (!button) throw new Error(`speaker button not found: ${key}`);
  return button;
}

function teamButton(container: HTMLElement): HTMLElement {
  const button = container.querySelector<HTMLElement>('[data-testid="speaker-filter-team"]');
  if (!button) throw new Error('team button not found');
  return button;
}

function iconClassOf(button: HTMLElement): string {
  const icon = button.querySelector('svg');
  if (!icon) throw new Error('speaker button has no icon');
  return icon.getAttribute('class') ?? '';
}

describe('ProjectTeamStrip 发言人筛选条', () => {
  it('「团队」按钮清除发言人筛选，回到显示全部发言人', async () => {
    const { container, onSelectSpeaker } = await renderStrip({ activeSpeakerKey: 'name:小林' });
    const team = teamButton(container);
    expect(team.textContent).toContain('团队');
    expect(team.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(team);
    expect(onSelectSpeaker).toHaveBeenCalledWith(null);
  });

  it('没有选中发言人时「团队」处于选中状态', async () => {
    const { container } = await renderStrip({ activeSpeakerKey: null });
    expect(teamButton(container).getAttribute('aria-pressed')).toBe('true');
  });

  it('按角色显示发言人标签，具体名字放在 title 里', async () => {
    const { container } = await renderStrip();
    expect(speakerButton(container, 'main').textContent).toContain('主agent');
    const commander = speakerButton(container, 'name:阿强');
    expect(commander.textContent).toContain('指挥');
    expect(commander.getAttribute('title')).toBe('只看 指挥 · 阿强');
    const reviewer = speakerButton(container, 'name:小林');
    expect(reviewer.textContent).toContain('审查');
    expect(reviewer.getAttribute('title')).toBe('只看 审查 · 小林');
  });

  it('每个发言人都有自己的图标，团队按钮用聚合图标', async () => {
    const { container } = await renderStrip();
    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="speaker-filter-item"]'),
    );
    expect(items).toHaveLength(3);
    const iconClasses = items.map(iconClassOf);
    expect(new Set(iconClasses).size).toBe(3);
    expect(iconClassOf(speakerButton(container, 'main'))).toMatch(/lucide-(bot|cpu|user-round)/);
    expect(iconClassOf(speakerButton(container, 'name:阿强'))).toMatch(/lucide-(crown|flag|medal)/);
    expect(iconClassOf(speakerButton(container, 'name:小林'))).toMatch(/lucide-(eye|search|clipboard-check)/);
    expect(iconClassOf(teamButton(container))).toMatch(/lucide-users/);
  });

  it('点击发言人只显示该发言人的回复', async () => {
    const { container, onSelectSpeaker } = await renderStrip({ activeSpeakerKey: null });
    const reviewer = speakerButton(container, 'name:小林');
    expect(reviewer.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(reviewer);
    expect(onSelectSpeaker).toHaveBeenCalledWith('name:小林');
  });

  it('已选中的发言人保持选中态，再点一次清除筛选', async () => {
    const { container, onSelectSpeaker } = await renderStrip({ activeSpeakerKey: 'name:小林' });
    const reviewer = speakerButton(container, 'name:小林');
    expect(reviewer.getAttribute('aria-pressed')).toBe('true');
    expect(speakerButton(container, 'name:阿强').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(reviewer);
    expect(onSelectSpeaker).toHaveBeenCalledWith(null);
  });

  it('英文文案同样可用', async () => {
    const { container } = await renderStrip({}, 'en');
    expect(teamButton(container).textContent).toContain('Team');
    expect(speakerButton(container, 'main').textContent).toContain('Main agent');
    expect(speakerButton(container, 'name:阿强').textContent).toContain('Commander');
    expect(speakerButton(container, 'name:小林').textContent).toContain('Reviewer');
  });

  it('中英文都提供 speaker/reply 文案', () => {
    expect(zhChat.speaker.team).toBe('团队');
    expect(zhChat.speaker.mainAgent).toBe('主agent');
    expect(zhChat.speaker.showAll).toBe('显示全部发言人');
    expect(zhChat.speaker.onlyThis).toBe('只看 {{name}}');
    expect(zhChat.reply.expand).toBe('展开回复');
    expect(enChat.speaker.team).toBe('Team');
    expect(enChat.speaker.mainAgent).toBe('Main agent');
    expect(enChat.speaker.showAll).toBe('Show all speakers');
    expect(enChat.speaker.onlyThis).toBe('Only {{name}}');
    expect(enChat.reply.expand).toBe('Expand reply');
  });
});
