import { useTranslation } from "react-i18next";

export default function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-[13px] text-muted-foreground">
      {message}
    </div>
  );
}
