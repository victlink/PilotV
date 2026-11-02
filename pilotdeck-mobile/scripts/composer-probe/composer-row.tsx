/**
 * 临时探针：用真实组件 + 真实样式测底部控制行在窄屏是否折行。
 *
 * 由 pilotdeck-mobile/scripts/browser-smoke-composer-row.mjs 通过 Vite 中间件
 * 挂载，路径别名 probe-css / probe-i18n / probe-composer 指向 UI 包内的真实文件。
 *
 * 用法：/probe/composer-row.html?w=366&lang=zh-CN&mode=agent
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import 'probe-css';
import 'probe-i18n';

import ComposerV2 from 'probe-composer';

const params = new URLSearchParams(window.location.search);
const width = Number(params.get('w') || 366);
const lang = params.get('lang') || 'zh-CN';

const AGENTS = [
  { id: 'agent-commander', name: 'Ada', role: 'commander', enabled: true },
  { id: 'agent-reviewer', name: 'Rob', role: 'reviewer', enabled: true },
];

const noop = () => {};

const props = {
  input: '',
  placeholder: 'Ask something',
  textareaRef: { current: null },
  inputHighlightRef: { current: null },
  renderInputWithMentions: () => null,
  onInputChange: noop,
  onTextareaClick: noop,
  onTextareaKeyDown: noop,
  onTextareaPaste: noop,
  onTextareaScrollSync: noop,
  onTextareaInput: noop,
  onSubmit: noop,
  onAbortSession: noop,
  openImagePicker: noop,
  onAddAttachmentFiles: noop,
  attachedImages: [],
  onRemoveImage: noop,
  onRetryImage: noop,
  documentReferences: [],
  onRemoveDocumentReference: noop,
  uploadingImages: new Map(),
  imageErrors: new Map(),
  showFileDropdown: false,
  fileMentionQuery: '',
  filteredFiles: [],
  selectedFileIndex: 0,
  isLoadingFiles: false,
  fileListError: null,
  hasMoreFiles: false,
  onLoadMoreFiles: noop,
  onSelectFile: noop,
  selectedFileMentions: [],
  onRemoveFileMention: noop,
  selectedSkills: [],
  onSelectSkill: noop,
  onRemoveSkill: noop,
  selectedCommands: [],
  onRemoveCommand: noop,
  filteredCommands: [],
  commandQuery: '',
  selectedCommandIndex: 0,
  onCommandSelect: noop,
  onCloseCommandMenu: noop,
  isCommandMenuOpen: false,
  frequentCommands: [],
  onToggleCommandMenu: noop,
  getRootProps: () => ({}),
  getInputProps: () => ({}),
  isDragActive: false,
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  modelCatalog: [],
  modelSelection: { mode: 'auto', provider: 'pilotdeck', model: 'openai/gpt-test' },
  onModelSelectionChange: noop,
  pendingPermissionRequests: [],
  handlePermissionDecision: noop,
  handleGrantToolPermission: () => ({ success: true }),
  permissionMode: 'default',
  onPermissionModeChange: noop,
  runMode: (params.get('mode') || 'agent') as never,
  onRunModeChange: noop,
  projectKey: '/workspace/demo',
  agents: AGENTS,
  selectedAgentId: null,
  onAgentSelectionChange: noop,
};

try {
  localStorage.setItem('userLanguage', lang);
} catch {
  /* ignore */
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <div style={{ width: `${width}px`, margin: '0 auto', border: '1px solid #334' }}>
      <ComposerV2 {...(props as never)} />
    </div>
  </StrictMode>,
);
