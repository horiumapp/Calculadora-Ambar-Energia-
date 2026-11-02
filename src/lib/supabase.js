import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey && !String(url).includes("SEU_PROJETO"));

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey)
  : null;
