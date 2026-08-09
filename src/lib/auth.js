import { supabase } from "./supabase";

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}
// Fires immediately with the current state, then again on every login/logout.
export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return data.subscription;
}
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}
export async function fetchProfile(userId) {
  const { data, error } = await supabase.from("profiles").select("id, role, name").eq("id", userId).single();
  if (error) throw error;
  return data;
}
// Only returns more than the caller's own row for an admin — enforced by
// the database (RLS), not by this function.
export async function fetchAllProfiles() {
  const { data, error } = await supabase.from("profiles").select("id, role, name").order("name");
  if (error) throw error;
  return data;
}
export async function updateOwnName(userId, name) {
  const { error } = await supabase.from("profiles").update({ name }).eq("id", userId);
  if (error) throw error;
}
