import React, { useEffect, useState } from "react";
import { type PopupStatusResponseData } from "@password-manager/shared";
import { sendToBackground } from "../messages/client.js";

export const App: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [statusData, setStatusData] = useState<PopupStatusResponseData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    const response = await sendToBackground<PopupStatusResponseData>({
      type: "POPUP_GET_STATUS",
    });

    if (response.ok) {
      setStatusData(response.data);
    } else {
      setError(response.error);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  return (
    <div className="popup-container">
      <header className="popup-header">
        <h1>Personal Password Manager</h1>
        <span className="badge">v0.1.0</span>
      </header>

      <main className="popup-content">
        <div className="status-card">
          <div className="status-row">
            <span className="label">Vault Status</span>
            <span
              className={`status-pill ${statusData?.status === "unlocked" ? "unlocked" : "locked"}`}
            >
              {loading ? "Checking..." : (statusData?.status ?? "locked").toUpperCase()}
            </span>
          </div>

          <p className="status-note">
            Phase 1 Foundation: Shell is active. Vault and crypto logic are planned for Phase 2.
          </p>

          {statusData && (
            <div className="debug-info">
              <p>
                <strong>Connected Worker:</strong> {statusData.appName}
              </p>
              <p>
                <strong>Handshake Time:</strong>{" "}
                {new Date(statusData.timestamp).toLocaleTimeString()}
              </p>
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}

          <button className="refresh-button" onClick={fetchStatus} disabled={loading}>
            {loading ? "Pinging Worker..." : "Ping Service Worker"}
          </button>
        </div>
      </main>
    </div>
  );
};
