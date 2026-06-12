import React, { useState } from "react";
import TradeLogin, { isLoggedIn, logout } from "./TradeLogin";
import TradingDashboard from "./TradingDashboard";

export default function TradeApp() {
  const [loggedIn, setLoggedIn] = useState(() => isLoggedIn());
  const [username, setUsername] = useState(() => {
    try {
      const raw = localStorage.getItem("tp_credentials");
      if (!raw) return "Trader";
      const creds = JSON.parse(atob(raw));
      return creds.username || "Trader";
    } catch { return "Trader"; }
  });

  const handleLogin = (uname) => {
    setUsername(uname);
    setLoggedIn(true);
  };

  const handleLogout = () => {
    if (!window.confirm("Sign out of TradePilot?")) return;
    logout();
    setLoggedIn(false);
  };

  if (!loggedIn) {
    return <TradeLogin onLogin={handleLogin} />;
  }

  // Pass a minimal user object so TradingDashboard can show the name
  const user = { name: username };

  return <TradingDashboard user={user} onLogout={handleLogout} />;
}
