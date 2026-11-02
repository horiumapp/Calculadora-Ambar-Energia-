import { supabase } from "./supabase.js";
import { normalizePhone } from "./format.js";

export async function fetchProfile(userId) {
  const { data: sessionData } = await supabase.auth.getSession();
  const sessionUserId = sessionData.session?.user?.id;
  if (!sessionUserId || sessionUserId !== userId) {
    throw new Error("Sessão inválida para carregar perfil.");
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", sessionUserId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveProfile(userId, { fullName, phone }) {
  const { data: sessionData } = await supabase.auth.getSession();
  const sessionUserId = sessionData.session?.user?.id;
  if (!sessionUserId || sessionUserId !== userId) {
    throw new Error("Sessão inválida para salvar perfil.");
  }

  const name = String(fullName || "").trim().slice(0, 120);
  const normalizedPhone = normalizePhone(phone).slice(0, 32);
  if (!name) throw new Error("Informe o nome completo.");
  if (!normalizedPhone) throw new Error("Informe um telefone válido.");

  const payload = {
    id: sessionUserId,
    full_name: name,
    phone: normalizedPhone,
  };
  const { data, error } = await supabase
    .from("profiles")
    .upsert(payload)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
