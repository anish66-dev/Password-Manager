import React, { useCallback, useEffect, useState } from "react";
import {
  type SyncStatusData,
  isDoneData,
  isRemoteVaultData,
  isSyncStatusData,
} from "@password-manager/shared";
import { sendToBackground } from "../messages/client.js";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function Banner({ kind, children }: { kind: "error" | "ok"; children: React.ReactNode }) {
  return (
    <div className={kind === "error" ? "error-banner" : "ok-banner"} role="alert">
      {children}
    </div>
  );
}

/** Sync status, refreshed every few seconds while the popup is open. */
export function useSyncStatus() {
  const [status, setStatus] = useState<SyncStatusData | null>(null);

  const refresh = useCallback(async () => {
    const res = await sendToBackground({ type: "SYNC_GET_STATUS" }, isSyncStatusData);
    if (res.ok) setStatus(res.data);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { status, refresh, setStatus };
}

function describe(status: SyncStatusData): string {
  if (!status.enabled) return "Cloud sync is off";
  switch (status.phase) {
    case "syncing":
      return "Syncing...";
    case "error":
      return status.error ?? "Sync failed";
    case "pending":
      return `${status.pendingChanges} change${status.pendingChanges === 1 ? "" : "s"} waiting to sync`;
    default:
      return `Synced ${timeAgo(status.lastSyncAt)}`;
  }
}

/** One line of sync status plus a Sync now button. */
export function SyncBar(props: {
  status: SyncStatusData | null;
  onStatus: (status: SyncStatusData) => void;
}) {
  const { status } = props;
  if (!status) return null;

  const syncNow = async () => {
    const res = await sendToBackground({ type: "SYNC_NOW" }, isSyncStatusData);
    if (res.ok) props.onStatus(res.data);
  };

  return (
    <div className="sync-bar">
      <span className={`sync-text ${status.phase === "error" ? "sync-error" : ""}`}>
        {describe(status)}
      </span>
      {status.enabled && (
        <button
          type="button"
          className="ghost"
          onClick={syncNow}
          disabled={status.phase === "syncing"}
        >
          Sync now
        </button>
      )}
      {status.rejected > 0 && (
        <div className="sync-warning">
          {status.rejected} cloud file(s) failed verification and were not used.
        </div>
      )}
    </div>
  );
}

/** Shown when the master password was changed on another device. */
export function NewPasswordBanner(props: { status: SyncStatusData | null; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!props.status?.needsNewPassword) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await sendToBackground(
      { type: "SYNC_APPLY_NEW_PASSWORD", payload: { password } },
      isDoneData
    );
    setBusy(false);
    setPassword("");
    if (res.ok) props.onDone();
    else setError(res.error);
  };

  return (
    <form className="status-card sync-new-password" onSubmit={submit}>
      <p className="status-note">
        Your master password was changed on another device. Enter the new master password to keep
        this device in sync.
      </p>
      <input
        type="password"
        value={password}
        autoComplete="current-password"
        placeholder="New master password"
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <Banner kind="error">{error}</Banner>}
      <button className="primary" type="submit" disabled={busy || password === ""}>
        {busy ? "Checking..." : "Use new password"}
      </button>
    </form>
  );
}

/** Connect or disconnect Google Drive. */
export function DriveSettings(props: {
  status: SyncStatusData | null;
  onStatus: (status: SyncStatusData) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enabled = props.status?.enabled === true;

  const run = async (type: "SYNC_SIGN_IN" | "SYNC_SIGN_OUT") => {
    setBusy(true);
    setError(null);
    const res = await sendToBackground({ type }, isSyncStatusData);
    setBusy(false);
    if (res.ok) props.onStatus(res.data);
    else setError(res.error);
  };

  return (
    <div className="field">
      <span className="label">Google Drive sync</span>
      <p className="status-note">
        {enabled
          ? "Signed in. Only encrypted data is stored in the hidden app data folder."
          : "Sync this vault between devices. Only encrypted data leaves this device."}
      </p>
      {error && <Banner kind="error">{error}</Banner>}
      {enabled ? (
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void run("SYNC_SIGN_OUT")}
        >
          Sign out of Google Drive
        </button>
      ) : (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void run("SYNC_SIGN_IN")}
        >
          {busy ? "Connecting..." : "Connect Google Drive"}
        </button>
      )}
    </div>
  );
}

/** On a device with no vault: join the vault that is already in Google Drive. */
export function RestoreFromDrive(props: { onDone: () => void }) {
  const [step, setStep] = useState<"start" | "password">("start");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    setError(null);
    const signedIn = await sendToBackground({ type: "SYNC_SIGN_IN" }, isSyncStatusData);
    if (!signedIn.ok) {
      setBusy(false);
      setError(signedIn.error);
      return;
    }
    const remote = await sendToBackground({ type: "SYNC_CHECK_REMOTE" }, isRemoteVaultData);
    setBusy(false);
    if (!remote.ok) setError(remote.error);
    else if (!remote.data.exists) setError("No vault was found in this Google account.");
    else setStep("password");
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await sendToBackground(
      { type: "SYNC_SETUP_FROM_CLOUD", payload: { password } },
      isDoneData
    );
    setBusy(false);
    setPassword("");
    if (res.ok) props.onDone();
    else setError(res.error);
  };

  return (
    <div className="status-card restore-card">
      <p className="status-note">Already have a vault on another device?</p>
      {step === "start" ? (
        <button type="button" className="ghost wide" disabled={busy} onClick={() => void connect()}>
          {busy ? "Connecting..." : "Restore from Google Drive"}
        </button>
      ) : (
        <form onSubmit={join}>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            placeholder="Master password of that vault"
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="primary" type="submit" disabled={busy || password === ""}>
            {busy ? "Unlocking..." : "Unlock and sync"}
          </button>
        </form>
      )}
      {error && <Banner kind="error">{error}</Banner>}
    </div>
  );
}
