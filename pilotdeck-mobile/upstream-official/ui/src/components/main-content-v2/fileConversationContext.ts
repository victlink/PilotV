import { createContext } from 'react';

// Keep the file browser's navigation local; it must not change the agent cwd.
export const FileConversationContext = createContext<{ id?: string; cwd?: string }>({});
