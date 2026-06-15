import React from "react";
import ReactDOM from "react-dom/client";
import TradeApp from "./TradeApp";
import ErrorBoundary from "./ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TradeApp />
    </ErrorBoundary>
  </React.StrictMode>
);
