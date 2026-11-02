import { useTranslation } from "react-i18next";
import { cn } from "../../../../../lib/utils";
import { TEAM_TABS, type TeamTabKey } from "../types";

type TeamTabsProps = {
  activeTab: TeamTabKey;
  onChangeTab: (tab: TeamTabKey) => void;
};

export default function TeamTabs({ activeTab, onChangeTab }: TeamTabsProps) {
  const { t } = useTranslation("projectTeam");

  return (
    <div
      role="tablist"
      aria-label={t("title")}
      className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 p-1"
    >
      {TEAM_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={activeTab === tab}
          onClick={() => onChangeTab(tab)}
          className={cn(
            "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
            activeTab === tab
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`tabs.${tab}`)}
        </button>
      ))}
    </div>
  );
}
