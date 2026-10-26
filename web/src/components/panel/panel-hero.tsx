import { useEffect, useState } from "react";
import s from "./panel-hero.module.css";

function greeting(hour: number): string {
  if (hour < 6) return "夜深了，今天想做点什么？";
  if (hour < 12) return "早上好，今天做点什么？";
  if (hour < 18) return "下午好，今天做点什么？";
  return "晚上好，今天做点什么？";
}

export function PanelHero() {
  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    const timer = window.setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return <h1 className={s.title}>{greeting(hour)}</h1>;
}
