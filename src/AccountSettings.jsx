import React, { useState } from "react";
import { updatePassword, updateOwnName } from "./lib/auth";

// Self-service for the logged-in user: change your own display name
// (shown in the header, and in the admin's manager-switcher instead of
// a raw email) and your own password. Works the same for a manager or
// the admin — nobody edits anyone else's account here.
export default function AccountSettings({ session, profile, onProfileUpdated, onClose }) {
  const [name, setName] = useState(profile.name || "");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState(null);
  const [savingName, setSavingName] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const handleSaveName = async () => {
    setStatus(null);
    setSavingName(true);
    try {
      await updateOwnName(session.user.id, name.trim());
      onProfileUpdated({ ...profile, name: name.trim() });
      setStatus({ type: "success", message: "Name updated." });
    } catch (err) {
      setStatus({ type: "error", message: err.message || String(err) });
    } finally {
      setSavingName(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setStatus(null);
    if (!newPassword || newPassword.length < 6) {
      setStatus({ type: "error", message: "Password must be at least 6 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatus({ type: "error", message: "Passwords don't match." });
      return;
    }
    setSavingPassword(true);
    try {
      await updatePassword(newPassword);
      setNewPassword(""); setConfirmPassword("");
      setStatus({ type: "success", message: "Password changed." });
    } catch (err) {
      setStatus({ type: "error", message: err.message || String(err) });
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-[#E4E7EC] p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold">Account settings</div>
        <button onClick={onClose} className="text-xs text-[#64748B] hover:text-[#1A2233]">Close</button>
      </div>
      {status && (
        <div className={`text-xs rounded px-3 py-2 mb-3 ${status.type === "error" ? "bg-[#FEE2E2] border border-[#DC2626] text-[#991B1B]" : "bg-[#ECFDF5] border border-[#A7F3D0] text-[#065F46]"}`}>
          {status.message}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b border-[#F1F5F9]">
        <div>
          <label className="block text-xs font-semibold text-[#64748B] mb-1">Display name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm w-56" />
        </div>
        <button onClick={handleSaveName} disabled={savingName} className="px-3 py-1.5 text-xs rounded border border-[#0D9488] text-[#0D9488] hover:bg-[#0D9488] hover:text-white disabled:opacity-50">
          {savingName ? "Saving…" : "Save name"}
        </button>
        <p className="text-xs text-[#64748B] max-w-xs">Shown in the header and, if you're an admin, in the manager-switcher — instead of a raw email address.</p>
      </div>
      <form onSubmit={handleChangePassword} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-semibold text-[#64748B] mb-1">New password</label>
          <input type="password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm w-48" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-[#64748B] mb-1">Confirm password</label>
          <input type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm w-48" />
        </div>
        <button type="submit" disabled={savingPassword} className="px-4 py-1.5 text-sm rounded bg-[#0D9488] text-white hover:bg-[#0B6B62] disabled:opacity-50">
          {savingPassword ? "Saving…" : "Change password"}
        </button>
      </form>
    </div>
  );
}
