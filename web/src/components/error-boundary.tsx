import { Component, type ErrorInfo, type ReactNode } from "react";
import { debugBus } from "@/lib/debug-bus";
import styles from "./error-boundary.module.css";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    debugBus.push({
      type: "exception",
      level: "error",
      summary: `[ErrorBoundary] ${error.message}`,
      payload: { stack: error.stack, componentStack: info.componentStack },
    });
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className={styles.container}>
          <div className={styles.card}>
            <h2 className={styles.title}>页面出现了错误</h2>
            <p className={styles.message}>{this.state.error.message}</p>
            <div className={styles.actions}>
              <button className={styles.button} onClick={this.handleRetry}>
                重试
              </button>
              <button className={styles.buttonSecondary} onClick={this.handleReload}>
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
