// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ProjectTeamStrip from './ProjectTeamStrip';
afterEach(cleanup);
it('shows configured members as available, not as participating until selected', () => {
 const select = vi.fn();
 render(<ProjectTeamStrip agents={[{id:'a',name:'Ada',role:'reviewer'}] as any} selectedAgentId={null} onSelect={select} />);
 expect(screen.getByRole('button', {name:'Ada'}).getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(screen.getByRole('button', {name:'Ada'}));
 expect(select).toHaveBeenCalledWith('a');
 expect(screen.queryByText('正在执行')).toBeNull();
});
it('can return to default agent and renders an icon for each member', () => {
 const select = vi.fn();
 const {container} = render(<ProjectTeamStrip agents={[{id:'a',name:'Ada',role:'reviewer'}] as any} selectedAgentId="a" onSelect={select} />);
 expect(screen.getByRole('button', {name:'Ada'}).getAttribute('aria-pressed')).toBe('true');
 expect(container.querySelector('svg')).not.toBeNull();
 fireEvent.click(screen.getByRole('button', {name:'默认 Agent'}));
 expect(select).toHaveBeenCalledWith(null);
});
