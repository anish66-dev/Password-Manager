import React, { useCallback, useEffect, useState } from "react";
import {
  MIN_MASTER_PASSWORD_LENGTH,
  type LoginDetail,
  type LoginSummary,
  type PopupStatusResponseData,
  type SyncStatusData,
  type VaultStatus,
  isDoneData,
  isPopupStatusData,
  isVaultEntryData,
  isVaultListData,
} from "@password-manager/shared";
import { sendToBackground } from "../messages/client.js";
import {
  DriveSettings,
  NewPasswordBanner,
  RestoreFromDrive,
  SyncBar,
  useSyncStatus,
} from "./SyncUi.js";

type View = { name: "list" } | { name: "form"; entry: LoginDetail | null } | { name: "settings" };

function ErrorBanner({ message }: { message: string | null }) {
  return message ? (
    <div className="error-banner" role="alert">
      {message}
    </div>
  ) : null;
}

function PasswordField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      <span className="field-row">
        <input
          type={shown ? "text" : "password"}
          value={props.value}
          autoComplete={props.autoComplete}
          autoFocus={props.autoFocus}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <button type="button" className="ghost" onClick={() => setShown((s) => !s)}>
          {shown ? "Hide" : "Show"}
        </button>
      </span>
    </label>
  );
}

function CreateVault({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters. A long passphrase is best.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await sendToBackground({ type: "VAULT_CREATE", payload: { password } }, isDoneData);
    setBusy(false);
    if (res.ok) {
      setPassword("");
      setConfirm("");
      onDone();
    } else {
      setError(res.error);
    }
  };

  return (
    <form className="status-card" onSubmit={submit}>
      <p className="status-note">
        Create your vault. There is no way to recover a forgotten master password.
      </p>
      <PasswordField
        label="Master password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        autoFocus
      />
      <PasswordField
        label="Confirm master password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
      <ErrorBanner message={error} />
      <button className="primary" type="submit" disabled={busy}>
        {busy ? "Creating..." : "Create vault"}
      </button>
    </form>
  );
}

function UnlockForm({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await sendToBackground({ type: "VAULT_UNLOCK", payload: { password } }, isDoneData);
    setBusy(false);
    setPassword("");
    if (res.ok) {
      onDone();
    } else {
      setError(res.error);
    }
  };

  return (
    <form className="status-card" onSubmit={submit}>
      <PasswordField
        label="Master password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        autoFocus
      />
      <ErrorBanner message={error} />
      <button className="primary" type="submit" disabled={busy || password.length === 0}>
        {busy ? "Unlocking..." : "Unlock"}
      </button>
    </form>
  );
}

function EntryForm(props: { entry: LoginDetail | null; onDone: () => void; onCancel: () => void }) {
  const { entry } = props;
  const [url, setUrl] = useState(entry?.url ?? "https://");
  const [username, setUsername] = useState(entry?.username ?? "");
  const [password, setPassword] = useState(entry?.password ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim() === "" || password === "") {
      setError("Site and password are required.");
      return;
    }
    const fields = { url: url.trim(), username: username.trim(), password };
    const res = entry
      ? await sendToBackground(
          { type: "VAULT_UPDATE", payload: { id: entry.id, ...fields } },
          isVaultEntryData
        )
      : await sendToBackground({ type: "VAULT_ADD", payload: fields }, isVaultEntryData);
    if (res.ok) {
      props.onDone();
    } else {
      setError(res.error);
    }
  };

  return (
    <form className="status-card" onSubmit={submit}>
      <label className="field">
        <span className="label">Site</span>
        <input value={url} autoFocus onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">Username or email</span>
        <input value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
      </label>
      <PasswordField
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
      <ErrorBanner message={error} />
      <div className="button-row">
        <button type="button" className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="primary" type="submit">
          {entry ? "Save changes" : "Add login"}
        </button>
      </div>
    </form>
  );
}

function SettingsView(props: {
  autoLockMinutes: number;
  sync: SyncStatusData | null;
  onSync: (status: SyncStatusData) => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [minutes, setMinutes] = useState(String(props.autoLockMinutes));
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saveMinutes = async () => {
    setError(null);
    setMessage(null);
    const res = await sendToBackground(
      { type: "VAULT_SET_AUTOLOCK", payload: { minutes: Number(minutes) } },
      isDoneData
    );
    if (res.ok) {
      setMessage("Auto-lock updated.");
      props.onChanged();
    } else {
      setError(res.error);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (next.length < MIN_MASTER_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`);
      return;
    }
    const res = await sendToBackground(
      { type: "VAULT_CHANGE_PASSWORD", payload: { currentPassword: current, newPassword: next } },
      isDoneData
    );
    setCurrent("");
    setNext("");
    if (res.ok) {
      setMessage("Master password changed.");
    } else {
      setError(res.error);
    }
  };

  return (
    <div className="status-card">
      <label className="field">
        <span className="label">Auto-lock after (minutes of inactivity)</span>
        <span className="field-row">
          <input
            type="number"
            min={1}
            max={240}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
          <button type="button" className="ghost" onClick={saveMinutes}>
            Save
          </button>
        </span>
      </label>
      <form onSubmit={changePassword}>
        <PasswordField
          label="Current master password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <PasswordField
          label="New master password"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
        />
        <button className="primary" type="submit" disabled={current === "" || next === ""}>
          Change master password
        </button>
      </form>
      <ErrorBanner message={error} />
      {message && <div className="ok-banner">{message}</div>}
      <DriveSettings status={props.sync} onStatus={props.onSync} />
      <button type="button" className="ghost wide" onClick={props.onBack}>
        Back
      </button>
    </div>
  );
}

function EntryRow(props: {
  entry: LoginSummary;
  onEdit: (entry: LoginDetail) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { entry } = props;
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fetchDetail = async (): Promise<LoginDetail | null> => {
    const res = await sendToBackground(
      { type: "VAULT_GET", payload: { id: entry.id } },
      isVaultEntryData
    );
    if (res.ok) return res.data.entry;
    props.onError(res.error);
    return null;
  };

  const toggle = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    const detail = await fetchDetail();
    if (detail) setRevealed(detail.password);
  };

  const edit = async () => {
    const detail = await fetchDetail();
    if (detail) props.onEdit(detail);
  };

  const remove = async () => {
    const res = await sendToBackground(
      { type: "VAULT_DELETE", payload: { id: entry.id } },
      isDoneData
    );
    if (res.ok) props.onChanged();
    else props.onError(res.error);
  };

  return (
    <li className="entry">
      <div className="entry-main">
        <div className="entry-url" title={entry.url}>
          {entry.url}
        </div>
        <div className="entry-user">
          {entry.username || "(no username)"}
          {entry.conflict && (
            <span
              className="badge conflict-badge"
              title="A version of a login that changed on two devices at once. Keep or delete it."
            >
              Conflict copy
            </span>
          )}
        </div>
        {revealed !== null && <div className="entry-password">{revealed}</div>}
      </div>
      <div className="entry-actions">
        <button type="button" className="ghost" onClick={toggle}>
          {revealed !== null ? "Hide" : "Show"}
        </button>
        <button type="button" className="ghost" onClick={edit}>
          Edit
        </button>
        {confirmDelete ? (
          <button type="button" className="danger" onClick={remove}>
            Confirm
          </button>
        ) : (
          <button type="button" className="ghost" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

function VaultView(props: {
  autoLockMinutes: number;
  onLocked: () => void;
  onSettingsChanged: () => void;
}) {
  const [view, setView] = useState<View>({ name: "list" });
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<LoginSummary[]>([]);
  const [rejected, setRejected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { status: sync, refresh: refreshSync, setStatus: setSync } = useSyncStatus();

  const { onLocked } = props;
  const load = useCallback(async () => {
    const res = await sendToBackground({ type: "VAULT_LIST", payload: { query } }, isVaultListData);
    if (res.ok) {
      setEntries(res.data.entries);
      setRejected(res.data.rejected);
      setError(null);
    } else {
      setError(res.error);
      if (res.error.includes("locked")) onLocked();
    }
  }, [query, onLocked]);

  useEffect(() => {
    if (view.name === "list") void load();
  }, [view.name, load]);

  const lock = async () => {
    await sendToBackground({ type: "VAULT_LOCK" }, isDoneData);
    onLocked();
  };

  return (
    <>
      <div className="toolbar">
        <button type="button" className="ghost" onClick={() => setView({ name: "settings" })}>
          Settings
        </button>
        <button type="button" className="ghost" onClick={lock}>
          Lock
        </button>
      </div>

      <NewPasswordBanner status={sync} onDone={() => void refreshSync()} />
      <SyncBar status={sync} onStatus={setSync} />

      {view.name === "settings" && (
        <SettingsView
          autoLockMinutes={props.autoLockMinutes}
          sync={sync}
          onSync={setSync}
          onBack={() => setView({ name: "list" })}
          onChanged={props.onSettingsChanged}
        />
      )}

      {view.name === "form" && (
        <EntryForm
          entry={view.entry}
          onDone={() => setView({ name: "list" })}
          onCancel={() => setView({ name: "list" })}
        />
      )}

      {view.name === "list" && (
        <div className="status-card">
          <div className="field-row">
            <input
              type="search"
              placeholder="Search logins"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="primary"
              onClick={() => setView({ name: "form", entry: null })}
            >
              Add
            </button>
          </div>
          <ErrorBanner message={error} />
          {rejected > 0 && (
            <div className="error-banner" role="alert">
              {rejected} stored record(s) failed verification and were skipped.
            </div>
          )}
          {entries.length === 0 ? (
            <p className="status-note">{query ? "No matching logins." : "No logins saved yet."}</p>
          ) : (
            <ul className="entries">
              {entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  onEdit={(detail) => setView({ name: "form", entry: detail })}
                  onChanged={() => void load()}
                  onError={setError}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

export const App: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [autoLockMinutes, setAutoLockMinutes] = useState(10);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await sendToBackground<PopupStatusResponseData>(
      { type: "POPUP_GET_STATUS" },
      isPopupStatusData
    );
    if (res.ok) {
      setStatus(res.data.status);
      setAutoLockMinutes(res.data.autoLockMinutes);
      setError(null);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const locked = status !== "unlocked";

  return (
    <div className="popup-container">
      <header className="popup-header">
        <h1>Personal Password Manager</h1>
        <span className={`status-pill ${locked ? "locked" : "unlocked"}`}>
          {loading ? "..." : status === "uninitialized" ? "NEW" : status.toUpperCase()}
        </span>
      </header>

      <main className="popup-content">
        <ErrorBanner message={error} />
        {!loading && status === "uninitialized" && (
          <>
            <CreateVault onDone={() => void refresh()} />
            <RestoreFromDrive onDone={() => void refresh()} />
          </>
        )}
        {!loading && status === "locked" && <UnlockForm onDone={() => void refresh()} />}
        {!loading && status === "unlocked" && (
          <VaultView
            autoLockMinutes={autoLockMinutes}
            onLocked={() => void refresh()}
            onSettingsChanged={() => void refresh()}
          />
        )}
      </main>
    </div>
  );
};
