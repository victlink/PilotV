// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(cleanup);
import FilesV2 from './FilesV2';
import { FileConversationContext } from './fileConversationContext';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }));
vi.mock('../ui/ConfirmDialog', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../file-tree/hooks/useFileTreeData', () => ({ useFileTreeData: () => ({ loading: false, refreshFiles: vi.fn(), files: [
  { name: 'one', path: '/project/one', type: 'directory', children: [{ name: 'a.txt', path: '/project/one/a.txt', type: 'file' }] },
  { name: 'two', path: '/project/two', type: 'directory', children: [{ name: 'b.txt', path: '/project/two/b.txt', type: 'file' }] },
] }) }));
const get = vi.hoisted(() => vi.fn());
vi.mock('../../utils/api', () => ({ api: { get } }));
const project = { name: 'project', displayName: 'Project', fullPath: '/project' };
const upload = { busy: false, start: vi.fn() } as never;
function view(id: string, cwd: string) {
  return <FileConversationContext.Provider value={{ id, cwd }}><FilesV2 selectedProject={project} workspaceUpload={upload} /></FileConversationContext.Provider>;
}
describe('conversation file directory', () => {
  it('lists the parent above the project and an arbitrary address as read-only', async () => {
    get.mockImplementation(async (url: string) => ({ ok: true, json: async () => ({
      path: url.includes('%2Fother') ? '/other' : '/',
      entries: [{ name: 'outside.txt', path: '/outside.txt', type: 'file' }],
    }) }));
    render(view('first', '/project'));
    fireEvent.click(screen.getByRole('button', { name: 'Parent directory' }));
    expect(await screen.findByText('outside.txt')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'New File' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'New Folder' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Download file' })).toBeNull();
    fireEvent.click(screen.getByText('outside.txt'));
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    const address = screen.getByRole('textbox', { name: 'Directory address' });
    fireEvent.change(address, { target: { value: '/other' } });
    fireEvent.submit(address.closest('form')!);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/browse-filesystem?path=%2Fother&includeFiles=true&showHidden=true'));
  });
  it('loads an external conversation cwd and ignores late navigation after switching conversations', async () => {
    let resolve!: (value: unknown) => void;
    get.mockReturnValue(new Promise(done => { resolve = done; }));
    const { rerender } = render(view('first', '/external'));
    expect(get).toHaveBeenCalledWith('/browse-filesystem?path=%2Fexternal&includeFiles=true&showHidden=true');
    rerender(view('second', '/project/two'));
    resolve({ ok: true, json: async () => ({ path: '/external', entries: [{ name: 'late.txt', path: '/external/late.txt', type: 'file' }] }) });
    await waitFor(() => expect(screen.getByText('b.txt')).toBeTruthy());
    expect(screen.queryByText('late.txt')).toBeNull();
  });
  it('defaults to the conversation cwd and resets when the conversation changes within a project', () => {
    const { rerender } = render(view('first', '/project/one'));
    expect((screen.getByRole('textbox', { name: 'Directory address' }) as HTMLInputElement).value).toBe('/project/one');
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.queryByText('b.txt')).toBeNull();
    rerender(view('second', '/project/two'));
    expect(screen.getByText('b.txt')).toBeTruthy();
    expect(screen.queryByText('a.txt')).toBeNull();
  });
  it('supports up, child directory and manual address navigation without changing the conversation cwd', async () => {
    get.mockResolvedValue({ ok: false, json: async () => ({ error: 'Directory not accessible' }) });
    render(view('first', '/project/one'));
    fireEvent.click(screen.getByRole('button', { name: 'Parent directory' }));
    fireEvent.doubleClick(screen.getByText('two'));
    expect(screen.getByText('b.txt')).toBeTruthy();
    const address = screen.getByRole('textbox', { name: 'Directory address' });
    fireEvent.change(address, { target: { value: '/project/one' } });
    fireEvent.submit(address.closest('form')!);
    expect(screen.getByText('a.txt')).toBeTruthy();
    fireEvent.change(address, { target: { value: '/missing' } });
    fireEvent.submit(address.closest('form')!);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
  });
});
