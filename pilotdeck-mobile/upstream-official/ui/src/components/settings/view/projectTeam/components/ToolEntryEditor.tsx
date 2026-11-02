import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "../../../../../lib/utils";
import {
  isValidToolEntry,
  PROJECT_TEAM_MAX_TOOL_ENTRIES,
} from "../../../../../lib/projectTeam";
import { describeToolLimitReached, resolveProjectTeamLocale } from "../validationMessages";

type ToolEntryEditorProps = {
  entries: string[];
  onChange: (entries: string[]) => void;
  listLabel: string;
  disabled?: boolean;
  /**
   * **当前列表**的条目上限。
   * 后端对白名单与黑名单分别限制条目数量，两个列表互不影响，
   * 所以这里只看本列表的条目数，不看另一个列表。
   */
  maxEntries?: number;
};

/**
 * 工具白名单/黑名单的条目编辑器。
 * 条目是自由文本，必须能实时看到哪一条非法，所以这里用原生 input 而不是共享的 TextInput。
 */
export default function ToolEntryEditor({
  entries,
  onChange,
  listLabel,
  disabled = false,
  maxEntries = PROJECT_TEAM_MAX_TOOL_ENTRIES,
}: ToolEntryEditorProps) {
  const { t, i18n } = useTranslation("projectTeam");
  const locale = resolveProjectTeamLocale(i18n?.language);
  const used = entries.length;
  const limitReached = used >= maxEntries;

  const updateEntry = (index: number, next: string) => {
    const draft = [...entries];
    draft[index] = next;
    onChange(draft);
  };

  const removeEntry = (index: number) => {
    onChange(entries.filter((_, position) => position !== index));
  };

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry, index) => {
        const invalid = !isValidToolEntry(entry);
        return (
          <div key={`${listLabel}-${index}`} className="flex items-center gap-2">
            <input
              type="text"
              value={entry}
              disabled={disabled}
              spellCheck={false}
              aria-label={t("tools.entryLabel", { index: index + 1 })}
              aria-invalid={invalid}
              onChange={(event) => updateEntry(index, event.target.value)}
              className={cn(
                "min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 font-mono text-xs leading-5 text-foreground outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                invalid
                  ? "border-destructive text-destructive"
                  : "border-border",
              )}
            />
            <button
              type="button"
              disabled={disabled}
              aria-label={t("tools.removeEntry")}
              title={t("tools.removeEntry")}
              onClick={() => removeEntry(index)}
              className="rounded-md p-1.5 text-muted-foreground transition-colors enabled:hover:bg-destructive/10 enabled:hover:text-destructive disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        disabled={disabled || limitReached}
        title={limitReached ? describeToolLimitReached(locale) : undefined}
        onClick={() => onChange([...entries, ""])}
        className="inline-flex h-7 w-fit items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[12px] text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-50"
      >
        <Plus size={13} />
        {t("tools.addEntry")}
      </button>
    </div>
  );
}
