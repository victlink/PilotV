import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { Select } from "../../../shared/components/Inputs";

type ProjectToolbarProps = {
  projectOptions: { value: string; label: string }[];
  projectRoot: string;
  onChangeProject: (next: string) => void;
  onReload: () => void;
  onSave: () => void;
  loading: boolean;
  saving: boolean;
  canSave: boolean;
};

export default function ProjectToolbar({
  projectOptions,
  projectRoot,
  onChangeProject,
  onReload,
  onSave,
  loading,
  saving,
  canSave,
}: ProjectToolbarProps) {
  const { t } = useTranslation("projectTeam");

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 sm:w-72">
        <label className="mb-1 block text-[13px] font-medium leading-5 text-foreground">
          {t("project")}
        </label>
        <Select
          value={projectRoot}
          onChange={onChangeProject}
          options={projectOptions}
          // 加载或保存期间不允许切换项目，避免请求与响应错配。
          disabled={loading || saving}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onReload}
          disabled={loading || saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[13px] text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw size={14} />
          {t("actions.reload")}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || loading || !canSave}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--pd-accent,#5b5ce2)] px-3 text-[13px] font-medium text-white transition-colors enabled:hover:bg-[var(--pd-accent-strong,#4948cf)] disabled:opacity-50"
        >
          {saving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          {saving ? t("actions.saving") : t("actions.save")}
        </button>
      </div>
    </div>
  );
}
