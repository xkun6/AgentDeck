import type { ReactNode } from "react";
import { TopBar } from "@/components/top-bar/top-bar";
import s from "./section-shell.module.css";

interface SectionShellProps {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  rail?: ReactNode;
  railLabel?: string;
  children: ReactNode;
}

export function SectionShell({
  title,
  sub,
  right,
  rail,
  railLabel = "页面右侧边栏",
  children,
}: SectionShellProps) {
  return (
    <main className={s.page}>
      {right ? <TopBar right={right} /> : null}
      <div className={s.body} data-with-rail={rail ? "true" : undefined}>
        <div className={s.scroll}>
          <div className={s.content}>
            <header className={s.head}>
              <h1 className={s.title}>{title}</h1>
              {sub ? <p className={s.sub}>{sub}</p> : null}
            </header>
            {children}
          </div>
        </div>
        {rail ? (
          <aside className={s.rail} aria-label={railLabel}>
            {rail}
          </aside>
        ) : null}
      </div>
    </main>
  );
}
