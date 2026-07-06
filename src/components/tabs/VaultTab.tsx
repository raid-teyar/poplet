import { useMemo, useState } from "react";
import {
  Copy,
  Dices,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  LockKeyhole,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import type { VaultEntry } from "../../types";
import {
  Button,
  EmptyState,
  IconButton,
  Input,
  Modal,
  ModalActions,
  ModalHeader,
  Textarea,
} from "../../ui";

type Fields = Omit<VaultEntry, "id" | "updated_at">;

const EMPTY: Fields = {
  label: "",
  username: "",
  secret: "",
  url: "",
  notes: "",
  category: "",
};

interface VaultTabProps {
  status: { initialized: boolean; unlocked: boolean };
  entries: VaultEntry[];
  searchQuery: string;
  onSetup: (passphrase: string) => Promise<void>;
  onUnlock: (passphrase: string) => Promise<void>;
  onLock: () => void;
  onSave: (fields: Fields, id: number | null) => Promise<void>;
  onDelete: (id: number) => void;
  onCopy: (text: string, label: string) => void;
  onExportBackup: (passphrase: string) => Promise<unknown>;
  onImportBackup: (passphrase: string) => Promise<void>;
}

/// Strong random secret using the platform CSPRNG.
function generateSecret(len = 20): string {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

function strength(pw: string): { score: number; label: string } {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const score = Math.min(s, 4);
  return { score, label: ["Weak", "Weak", "Fair", "Good", "Strong"][score] };
}

export default function VaultTab({
  status,
  entries,
  searchQuery,
  onSetup,
  onUnlock,
  onLock,
  onSave,
  onDelete,
  onCopy,
  onExportBackup,
  onImportBackup,
}: VaultTabProps) {
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [backupPass, setBackupPass] = useState("");
  const [backupMsg, setBackupMsg] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);

  const runBackup = async (kind: "export" | "import") => {
    setBackupMsg("");
    if (backupPass.length < 8) {
      setBackupMsg("Backup passphrase must be at least 8 characters.");
      return;
    }
    setBackupBusy(true);
    try {
      if (kind === "export") {
        const ok = await onExportBackup(backupPass);
        setBackupMsg(ok ? "Backup exported." : "");
      } else {
        await onImportBackup(backupPass);
        setBackupMsg("Backup imported.");
      }
      setBackupPass("");
    } catch (e) {
      setBackupMsg(String(e));
    } finally {
      setBackupBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      [e.label, e.username, e.url, e.category].some((v) =>
        (v ?? "").toLowerCase().includes(q),
      ),
    );
  }, [entries, searchQuery]);

  const doSetup = async () => {
    setError("");
    if (pass.length < 8) return setError("Use at least 8 characters.");
    if (pass !== pass2) return setError("Passphrases don't match.");
    setBusy(true);
    try {
      await onSetup(pass);
      setPass("");
      setPass2("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doUnlock = async () => {
    setError("");
    setBusy(true);
    try {
      await onUnlock(pass);
      setPass("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openAdd = () => {
    setEditId(null);
    setFields(EMPTY);
    setModalOpen(true);
  };
  const openEdit = (e: VaultEntry) => {
    setEditId(e.id);
    setFields({
      label: e.label,
      username: e.username,
      secret: e.secret,
      url: e.url,
      notes: e.notes,
      category: e.category,
    });
    setModalOpen(true);
  };
  const save = async () => {
    if (!fields.label.trim() && !fields.secret.trim()) return;
    await onSave(fields, editId);
    setModalOpen(false);
  };

  // ── Not set up: create a master passphrase ───────────────────────────
  if (!status.initialized) {
    const st = strength(pass);
    return (
      <div className="vault-gate">
        <ShieldCheck size={30} className="vault-gate-icon" />
        <h3>Create your vault</h3>
        <p className="vault-hint">
          Your credentials are encrypted with this passphrase (Argon2id +
          XChaCha20-Poly1305). It's never stored — <strong>if you lose it,
          the data is unrecoverable.</strong> Use a long, unique passphrase.
        </p>
        <Input
          type="password"
          placeholder="Master passphrase"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        {pass && (
          <div className={`vault-strength s${st.score}`}>
            <span />
            <em>{st.label}</em>
          </div>
        )}
        <Input
          type="password"
          placeholder="Confirm passphrase"
          value={pass2}
          onChange={(e) => setPass2(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSetup()}
        />
        {error && <p className="error-state">{error}</p>}
        <Button
          variant="primary"
          icon={<ShieldCheck size={14} />}
          onClick={doSetup}
          disabled={busy}
        >
          {busy ? "Creating…" : "Create vault"}
        </Button>
      </div>
    );
  }

  // ── Locked: enter passphrase ─────────────────────────────────────────
  if (!status.unlocked) {
    return (
      <div className="vault-gate">
        <LockKeyhole size={30} className="vault-gate-icon" />
        <h3>Vault locked</h3>
        <Input
          type="password"
          placeholder="Master passphrase"
          value={pass}
          autoFocus
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doUnlock()}
        />
        {error && <p className="error-state">{error}</p>}
        <Button
          variant="primary"
          icon={<KeyRound size={14} />}
          onClick={doUnlock}
          disabled={busy}
        >
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </div>
    );
  }

  // ── Unlocked: entry list ─────────────────────────────────────────────
  return (
    <>
      <div className="vault-panel">
        <div className="vault-toolbar">
          <Button icon={<Lock size={13} />} onClick={onLock} title="Lock vault">
            Lock
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={openAdd}>
            Add
          </Button>
        </div>

        {filtered.length === 0 && (
          <EmptyState>
            {entries.length === 0 ? "No credentials yet" : "No matches"}
          </EmptyState>
        )}

        <div className="vault-list">
          {filtered.map((e) => {
            const show = revealed.has(e.id);
            return (
              <div className="vault-item" key={e.id}>
                <div className="vault-item-head">
                  <div className="vault-item-title">
                    <KeyRound size={13} />
                    <span>{e.label || "Untitled"}</span>
                    {e.category && <span className="vault-cat">{e.category}</span>}
                  </div>
                  <div className="note-actions">
                    <IconButton title="Edit" onClick={() => openEdit(e)}>
                      <Pencil size={13} />
                    </IconButton>
                    <IconButton title="Delete" onClick={() => onDelete(e.id)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </div>
                {e.username && (
                  <div className="vault-field">
                    <span className="vault-field-label">User</span>
                    <span className="vault-field-value">{e.username}</span>
                    <IconButton
                      size="sm"
                      title="Copy username"
                      onClick={() => onCopy(e.username, "Username")}
                    >
                      <Copy size={12} />
                    </IconButton>
                  </div>
                )}
                <div className="vault-field">
                  <span className="vault-field-label">Secret</span>
                  <span className="vault-field-value mono">
                    {show ? e.secret : "•".repeat(Math.min(12, e.secret.length || 6))}
                  </span>
                  <IconButton
                    size="sm"
                    title={show ? "Hide" : "Reveal"}
                    onClick={() =>
                      setRevealed((prev) => {
                        const next = new Set(prev);
                        next.has(e.id) ? next.delete(e.id) : next.add(e.id);
                        return next;
                      })
                    }
                  >
                    {show ? <EyeOff size={12} /> : <Eye size={12} />}
                  </IconButton>
                  <IconButton
                    size="sm"
                    title="Copy secret"
                    onClick={() => onCopy(e.secret, "Secret")}
                  >
                    <Copy size={12} />
                  </IconButton>
                </div>
                {e.url && <div className="vault-url">{e.url}</div>}
                {e.notes && <div className="note-body">{e.notes}</div>}
              </div>
            );
          })}
        </div>

        <div className="vault-backup">
          <div className="vault-backup-title">Encrypted backup</div>
          <p className="vault-hint">
            Bundles your secrets, notes and projects into one file, sealed with
            this passphrase. Keep it safe — it's the key to everything inside.
          </p>
          <Input
            type="password"
            placeholder="Backup passphrase"
            value={backupPass}
            onChange={(e) => setBackupPass(e.target.value)}
          />
          <div className="vault-backup-actions">
            <Button
              icon={<Download size={13} />}
              onClick={() => runBackup("export")}
              disabled={backupBusy}
            >
              Export
            </Button>
            <Button
              icon={<Upload size={13} />}
              onClick={() => runBackup("import")}
              disabled={backupBusy}
            >
              Import
            </Button>
          </div>
          {backupMsg && <p className="vault-backup-msg">{backupMsg}</p>}
        </div>
      </div>

      {modalOpen && (
        <Modal onClose={() => setModalOpen(false)}>
          <ModalHeader
            title={editId !== null ? "Edit credential" : "Add credential"}
            onClose={() => setModalOpen(false)}
          />
          <Input
            placeholder="Label (e.g. GitHub token)"
            value={fields.label}
            autoFocus
            onChange={(e) => setFields({ ...fields, label: e.target.value })}
          />
          <div className="vault-form-row">
            <Input
              placeholder="Username / email"
              value={fields.username}
              onChange={(e) => setFields({ ...fields, username: e.target.value })}
            />
            <Input
              placeholder="Category"
              value={fields.category}
              onChange={(e) => setFields({ ...fields, category: e.target.value })}
            />
          </div>
          <div className="vault-secret-row">
            <Textarea
              placeholder="Secret / password / key"
              value={fields.secret}
              spellCheck={false}
              onChange={(e) => setFields({ ...fields, secret: e.target.value })}
            />
            <Button
              className="vault-gen"
              icon={<Dices size={13} />}
              title="Generate a strong secret"
              onClick={() => setFields({ ...fields, secret: generateSecret() })}
            >
              Generate
            </Button>
          </div>
          <Input
            placeholder="URL (optional)"
            value={fields.url}
            onChange={(e) => setFields({ ...fields, url: e.target.value })}
          />
          <Textarea
            placeholder="Notes (optional)"
            value={fields.notes}
            onChange={(e) => setFields({ ...fields, notes: e.target.value })}
          />
          <ModalActions>
            <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}
