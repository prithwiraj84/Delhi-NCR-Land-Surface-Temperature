import { Component } from "react";
import { ErrorState } from "./ErrorState.jsx";

/**
 * Catches render errors in one view so a crash in (say) a chart never takes down the whole
 * dashboard. The boundary resets itself when `resetKey` changes (e.g. the active view or
 * epoch) or when the user presses retry.
 * @param {{resetKey?: unknown, title?: string, compact?: boolean, fallback?: Function}} props
 *   `fallback({error, reset})` may replace the default error panel.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    const { children, fallback, title = "This panel failed to render", compact = false } = this.props;
    if (!error) return children;
    if (typeof fallback === "function") return fallback({ error, reset: this.reset });
    return <ErrorState title={title} error={error} onRetry={this.reset} retryLabel="Reload panel" compact={compact} />;
  }
}

export default ErrorBoundary;
