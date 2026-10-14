// 手机端输入区：发送 / 运行中插话（provider 支持 steer）/ 取消。撤回按钮在消息气泡上（MessageTimeline 的 retract 操作）。
import s from "./mobile.module.css";

export interface MobileComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** 本轮进行中 */
  busy: boolean;
  connected: boolean;
  /** provider 支持运行中插话（capabilities.steer） */
  steerSupported: boolean;
  onSend: () => void;
  onSteer: () => void;
  onCancel: () => void;
}

export function MobileComposer({
  value,
  onChange,
  busy,
  connected,
  steerSupported,
  onSend,
  onSteer,
  onCancel,
}: MobileComposerProps) {
  const canType = connected && (!busy || steerSupported);
  const empty = !value.trim();
  const placeholder = !connected
    ? "未连接电脑"
    : busy
      ? steerSupported
        ? "运行中，可插话给 Agent"
        : "Agent 运行中，可取消本轮"
      : "给 Agent 发消息";

  return (
    <form
      className={s.inputBar}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) {
          if (steerSupported && !empty) onSteer();
        } else if (!empty && connected) {
          onSend();
        }
      }}
    >
      <textarea
        className={s.textarea}
        value={value}
        rows={1}
        disabled={!canType}
        placeholder={placeholder}
        aria-label="消息输入框"
        onChange={(event) => onChange(event.target.value)}
      />
      {busy ? (
        <div className={s.inputActions}>
          {steerSupported ? (
            <button type="submit" className={s.primaryButton} disabled={empty || !connected}>
              插话
            </button>
          ) : null}
          <button type="button" className={s.dangerButton} onClick={onCancel} disabled={!connected}>
            取消
          </button>
        </div>
      ) : (
        <button type="submit" className={s.primaryButton} disabled={empty || !connected}>
          发送
        </button>
      )}
    </form>
  );
}
