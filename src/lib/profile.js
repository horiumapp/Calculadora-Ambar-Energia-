import { supabase } from "./supabase.js";
import { normalizePhone } from "./format.js";

export async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveProfile(userId, { fullName, phone }) {
  const payload = {
    id: userId,
    full_name: fullName.trim(),
    phone: normalizePhone(phone),
  };
  const { data, error } = await supabase
    .from("profiles")
    .upsert(payload)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
