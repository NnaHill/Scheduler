import React, { useState, useEffect } from "react";
import { getSession, onAuthStateChange, fetchProfile, signOut } from "./lib/auth";
import Login from "./Login";

// Wraps the whole app: shows the login screen until someone's signed in,
// then loads their profile (role: admin/manager) and hands both down to
// children as a render prop — `<AuthGate>{({ session, profile, signOut }) => <App .../>}</AuthGate>`.
// Kept separate from App.jsx on purpose: App.jsx has no idea auth exists
// beyond receiving these two values as props.
export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getSession().then((s) => { if (!cancelled) setSession(s); }).catch(() => { if (!cancelled) setSession(null); });
    const sub = onAuthStateChange((s) => { if (!cancelled) setSession(s); });
    return () => { cancelled = true; sub.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); setProfileError(null); return; }
    let cancelled = false;
    fetchProfile(session.user.id)
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch((err) => { if (!cancelled) setProfileError(err.message || String(err)); });
    return () => { cancelled = true; };
  }, [session]);

  if (session === undefined) {
    return <div style={{ fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen bg-[#F7F8FA] flex items-center justify-center text-sm text-[#64748B]">Loading…</div>;
  }
  if (!session) return <Login />;
  if (profileError) {
    return (
      <div style={{ fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen bg-[#F7F8FA] flex flex-col items-center justify-center text-sm text-[#DC2626] p-4 text-center gap-3">
        <div>Couldn't load your account profile: {profileError}</div>
        <button onClick={signOut} className="underline text-[#64748B]">Sign out</button>
      </div>
    );
  }
  if (!profile) {
    return <div style={{ fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen bg-[#F7F8FA] flex items-center justify-center text-sm text-[#64748B]">Loading your profile…</div>;
  }

  return children({ session, profile, signOut });
}
