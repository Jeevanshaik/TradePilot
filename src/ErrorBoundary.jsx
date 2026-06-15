import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error("TradePilot crashed:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{
        minHeight: "100vh",
        background: "#0F0720",
        color: "#E2D9F3",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        padding: 24,
      }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
        <h2 style={{ color: "#EF4444", margin: "0 0 12px" }}>TradePilot hit an error</h2>
        <p style={{ opacity: 0.7, fontSize: 13, marginBottom: 16 }}>
          The app crashed instead of working. Screenshot this and share it — it tells us exactly what went wrong.
        </p>
        <pre style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 12,
          background: "rgba(0,0,0,.35)",
          border: "1px solid rgba(239,68,68,.3)",
          borderRadius: 8,
          padding: 14,
          color: "#FCA5A5",
          maxHeight: "50vh",
          overflow: "auto",
        }}>
          {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          {this.state.info?.componentStack ? "\n\n--- component stack ---\n" + this.state.info.componentStack : ""}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 18, background: "linear-gradient(135deg,#7C3AED,#5B21B6)",
            border: "none", borderRadius: 10, color: "#fff",
            fontWeight: 800, fontSize: 14, padding: "12px 28px", cursor: "pointer",
          }}
        >
          🔄 Reload
        </button>
      </div>
    );
  }
}
