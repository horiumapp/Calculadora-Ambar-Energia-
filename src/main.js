import "./styles.css";
import { supabase, isSupabaseConfigured } from "./lib/supabase.js";
import { fetchProfile, saveProfile } from "./lib/profile.js";
import { initCalculator, reloadBills } from "./calculator.js";

const $ = (id) => document.getElementById(id);

const authView = $("auth-view");
const appView = $("app-view");
const configView = $("config-view");
const authError = $("auth-error");
const profileError = $("profile-error");
const profileOk = $("profile-ok");

let calculatorReady = false;
let currentUser = null;

function showView(view) {
  authView.hidden = view !== "auth";
  appView.hidden = view !== "app";
  configView.hidden = view !== "config";
}

function setAuthMode(mode) {
  const isLogin = mode === "login";
  $("auth-title").textContent = isLogin ? "Entrar na conta" : "Criar conta";
  $("auth-submit").textContent = isLogin ? "Entrar" : "Cadastrar";
  $("auth-toggle").textContent = isLogin ? "Criar uma conta" : "Já tenho conta";
  $("auth-form").dataset.mode = mode;
  $("auth-name-field").hidden = isLogin;
  authError.hidden = true;
}

function isProfileComplete(profile) {
  return Boolean(profile?.full_name?.trim() && profile?.phone?.trim());
}

function setProfileEditorOpen(open) {
  $("profile-section").hidden = !open;
  $("edit-profile-btn").hidden = open;
  if (open) {
    profileError.hidden = true;
    profileOk.hidden = true;
  }
}

async function refreshProfileUI(userId, { openEditor } = {}) {
  const profile = await fetchProfile(userId);
  $("profile-name").value = profile?.full_name || "";
  $("profile-phone").value = profile?.phone || "";
  $("customer-line").textContent =
    `${profile?.full_name || "Cliente"} · ${profile?.phone || "telefone não cadastrado"}`;
  $("user-email").textContent = profile?.full_name?.trim() || currentUser?.email || "Cliente";

  if (typeof openEditor === "boolean") setProfileEditorOpen(openEditor);
  else setProfileEditorOpen(!isProfileComplete(profile));
  return profile;
}

async function enterApp(session) {
  currentUser = session.user;
  showView("app");
  await refreshProfileUI(currentUser.id);
  if (!calculatorReady) {
    await initCalculator(currentUser.id);
    calculatorReady = true;
  } else {
    await reloadBills(currentUser.id);
  }
}

function wireAuth() {
  setAuthMode("login");

  $("auth-toggle").addEventListener("click", () => {
    const next = $("auth-form").dataset.mode === "login" ? "signup" : "login";
    setAuthMode(next);
  });

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.hidden = true;
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const fullName = $("auth-name").value.trim();
    const mode = $("auth-form").dataset.mode;

    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (error) throw error;
        if (data.session) {
          if (fullName) await saveProfile(data.user.id, { fullName, phone: "" });
          await enterApp(data.session);
        } else {
          authError.textContent = "Conta criada. Confirme o e-mail (se exigido) e faça login.";
          authError.hidden = false;
          setAuthMode("login");
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await enterApp(data.session);
      }
    } catch (error) {
      authError.textContent = error.message || "Falha na autenticação.";
      authError.hidden = false;
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await supabase.auth.signOut();
    currentUser = null;
    showView("auth");
    setAuthMode("login");
  });

  $("edit-profile-btn").addEventListener("click", () => {
    setProfileEditorOpen(true);
    $("profile-name").focus();
  });

  $("cancel-profile-btn").addEventListener("click", async () => {
    const profile = await fetchProfile(currentUser.id);
    if (isProfileComplete(profile)) {
      $("profile-name").value = profile.full_name || "";
      $("profile-phone").value = profile.phone || "";
      setProfileEditorOpen(false);
    } else {
      profileError.textContent = "Preencha nome e telefone para continuar.";
      profileError.hidden = false;
    }
  });

  $("profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    profileError.hidden = true;
    profileOk.hidden = true;
    try {
      await saveProfile(currentUser.id, {
        fullName: $("profile-name").value,
        phone: $("profile-phone").value,
      });
      await refreshProfileUI(currentUser.id, { openEditor: false });
    } catch (error) {
      profileError.textContent = error.message || "Não foi possível salvar o perfil.";
      profileError.hidden = false;
    }
  });
}

async function boot() {
  if (!isSupabaseConfigured) {
    showView("config");
    return;
  }

  wireAuth();
  const { data } = await supabase.auth.getSession();
  if (data.session) await enterApp(data.session);
  else showView("auth");

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_OUT") {
      currentUser = null;
      showView("auth");
    }
    if (event === "SIGNED_IN" && session) {
      await enterApp(session);
    }
  });
}

boot();
