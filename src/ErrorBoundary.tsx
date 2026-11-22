import { Component, type ReactNode } from "react";

/** Shows the error and a Reload button instead of a blank window if the UI crashes. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h1>Something went wrong</h1>
        <p>Your board is saved on disk and is safe. Reload the app to continue.</p>
        <pre>{String(this.state.error.stack ?? this.state.error)}</pre>
        <div className="row">
          <button className="primary" onClick={() => window.location.reload()}>Reload</button>
          <button onClick={() => navigator.clipboard.writeText(String(this.state.error?.stack ?? this.state.error))}>Copy error</button>
        </div>
      </div>
    );
  }
}
