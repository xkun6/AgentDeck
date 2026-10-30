// 配对页：粘贴配对链接（也接受整段文本）或扫码结果 → 解析 → 连接电脑发送 pair → 存凭据 → 进入该电脑。
import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { PairingError, pairWithOffer, parsePairingInput, type PairOverrides } from "@/lib/remote/pairing";
import type { PairedHost } from "@/lib/remote/hosts";
import { isTauriShell, scanPairingQr } from "./platform";
import s from "./mobile.module.css";

export interface PairScreenProps {
  deviceName: string;
  /** 配对成功：调用方存储主机、切换连接并导航 */
  onPaired: (host: PairedHost, deviceName: string) => void | Promise<void>;
  onBack: () => void;
  /** 进入页面时自动扫码（从电脑列表的「扫码配对」进来） */
  autoScan?: boolean;
  /** 测试注入：替换底层 socket */
  pairOverrides?: PairOverrides;
}

export function PairScreen({ deviceName, onPaired, onBack, autoScan = false, pairOverrides }: PairScreenProps) {
  const [text, setText] = useState("");
  const [name, setName] = useState(deviceName);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const autoScanned = useRef(false);

  const submit = async (input: string) => {
    setError(null);
    let offer;
    try {
      offer = parsePairingInput(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setPairing(true);
    const finalName = name.trim() || deviceName;
    try {
      const host = await pairWithOffer(offer, finalName, pairOverrides);
      await onPaired(host, finalName);
    } catch (e) {
      setError(e instanceof PairingError ? e.message : `配对失败：${e instanceof Error ? e.message : String(e)}`);
      setPairing(false);
    }
  };

  const scan = async () => {
    setError(null);
    const result = await scanPairingQr();
    if (!result.ok) {
      if (!result.canceled) setError(result.message);
      return;
    }
    setText(result.content);
    await submit(result.content);
  };

  useEffect(() => {
    if (autoScan && !autoScanned.current && isTauriShell()) {
      autoScanned.current = true;
      void scan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScan]);

  return (
    <div className={s.page}>
      <header className={s.header}>
        <button type="button" className={s.iconButton} onClick={onBack} aria-label="返回">
          <ChevronLeft aria-hidden="true" />
        </button>
        <h1 className={s.titleSmall}>配对电脑</h1>
      </header>
      <div className={s.body}>
        <div className={s.sheet}>
          <label className={s.field}>
            <span>本机名称（电脑上显示的设备名）</span>
            <input className={s.control} value={name} onChange={(e) => setName(e.target.value)} disabled={pairing} />
          </label>
          <label className={s.field}>
            <span>配对链接</span>
            <textarea
              className={s.pasteArea}
              value={text}
              rows={4}
              placeholder="粘贴 agentdeck://pair#… 链接（整段文字也可以）"
              onChange={(e) => setText(e.target.value)}
              disabled={pairing}
              aria-label="配对链接"
            />
          </label>
          {error ? (
            <div className={s.error} role="alert">
              {error}
            </div>
          ) : null}
          <button
            type="button"
            className={s.primaryButton}
            disabled={pairing || !text.trim()}
            onClick={() => void submit(text)}
          >
            {pairing ? "正在配对…" : "配对"}
          </button>
          {isTauriShell() ? (
            <button type="button" className={s.secondaryButton} disabled={pairing} onClick={() => void scan()}>
              扫码配对
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
