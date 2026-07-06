import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/// Catches render/runtime errors so a crash shows a readable, OPAQUE panel
/// instead of leaving a blank tree — which, with a transparent window, would
/// look like the whole app vanished.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Poplet crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash-screen">
          <h2>Poplet hit an error</h2>
          <pre>{String(this.state.error?.stack || this.state.error)}</pre>
          <button className="crash-reload" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
