import React, { useState } from "react";
import { signIn } from "./lib/auth";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err.message || "Sign-in failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen bg-[#F7F8FA] flex items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-[#E4E7EC] p-6 w-full max-w-sm">
        <h1 className="text-lg font-bold mb-1">Shift Scheduler</h1>
        <p className="text-xs text-[#64748B] mb-4">Sign in to your account.</p>
        {error && <div className="bg-[#FEE2E2] border border-[#DC2626] text-[#991B1B] text-xs rounded px-3 py-2 mb-3">{error}</div>}
        <label className="block text-xs font-semibold text-[#64748B] mb-1">Email</label>
        <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border border-[#E4E7EC] rounded px-3 py-2 text-sm mb-3" />
        <label className="block text-xs font-semibold text-[#64748B] mb-1">Password</label>
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full border border-[#E4E7EC] rounded px-3 py-2 text-sm mb-4" />
        <button type="submit" disabled={loading} className="w-full px-4 py-2 text-sm font-semibold rounded bg-[#0D9488] text-white hover:bg-[#0B6B62] disabled:opacity-50">
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
