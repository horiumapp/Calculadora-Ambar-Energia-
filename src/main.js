import "./styles.css";
import { supabase, isSupabaseConfigured } from "./lib/supabase.js";
import { fetchProfile, saveProfile } from "./lib/profile.js";
import { initCalculator, reloadBills } from "./calculator.js";
import { BILL_LIMITS, sanitizeAuthError } from "./lib/validation.js";

const $ = (id) => document.getElementById(id);

const authView = $("auth-view");
const appView = $("app-view");
const configView = $("config-view");
const authError = $("auth-error");
const authOk = $("auth-ok");
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
  const isReset = mode === "reset";
  $("auth-title").textContent = isReset
    ? "Recuperar senha"
    : isLogin
      ? "Entrar na conta"
      : "Criar conta";
  $("auth-submit").textContent = isReset
    ? "Enviar link"
    : isLogin
      ? "Entrar"
      : "Cadastrar";
  const toggleLabel = isLogin ? "Criar uma conta" : "Já tenho conta";
  $("auth-toggle-label").textContent = toggleLabel;
  $("auth-toggle").title = toggleLabel;
  $("auth-toggle").setAttribute("aria-label", toggleLabel);
  const signupIcon = $("auth-toggle").querySelector(".gate-icon-signup");
  const signinIcon = $("auth-toggle").querySelector(".gate-icon-signin");
  if (signupIcon && signinIcon) {
    signupIcon.hidden = !isLogin;
    signinIcon.hidden = isLogin;
  }
  $("auth-form").dataset.mode = mode;
  $("auth-name-field").hidden = !(!isLogin && !isReset);
  $("auth-password-field").hidden = isReset;
  $("auth-forgot").hidden = !isLogin;
  $("auth-back-login").hidden = !isReset;
  authError.hidden = true;
  if (authOk) authOk.hidden = true;
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

function resetClientState() {
  currentUser = null;
  calculatorReady = false;
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

  $("auth-password-toggle").addEventListener("click", () => {
    const input = $("auth-password");
    const toggle = $("auth-password-toggle");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(show));
    toggle.title = show ? "Ocultar senha" : "Mostrar senha";
    toggle.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
    toggle.querySelector(".eye-open").hidden = show;
    toggle.querySelector(".eye-closed").hidden = !show;
  });

  $("auth-toggle").addEventListener("click", () => {
    const next = $("auth-form").dataset.mode === "login" ? "signup" : "login";
    setAuthMode(next);
  });

  $("auth-forgot").addEventListener("click", () => setAuthMode("reset"));
  $("auth-back-login").addEventListener("click", () => setAuthMode("login"));

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.hidden = true;
    if (authOk) authOk.hidden = true;

    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const fullName = $("auth-name").value.trim();
    const mode = $("auth-form").dataset.mode;

    try {
      if (mode === "reset") {
        const redirectTo = `${window.location.origin}/`;
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        if (authOk) {
          authOk.textContent = "Se o e-mail existir, enviaremos instruções de recuperação.";
          authOk.hidden = false;
        }
        return;
      }

      if (mode === "signup") {
        if (password.length < BILL_LIMITS.minPasswordLength) {
          throw new Error(`Use uma senha com pelo menos ${BILL_LIMITS.minPasswordLength} caracteres.`);
        }
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (error) throw error;
        if (data.session) {
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
      const isPasswordPolicy =
        mode === "signup" &&
        String(error?.message || "").includes(`${BILL_LIMITS.minPasswordLength} caracteres`);
      authError.textContent = isPasswordPolicy
        ? error.message
        : sanitizeAuthError(error, mode);
      authError.hidden = false;
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await supabase.auth.signOut({ scope: "local" });
    resetClientState();
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
      resetClientState();
      showView("auth");
    }
    if (event === "SIGNED_IN" && session) {
      await enterApp(session);
    }
    if (event === "TOKEN_REFRESHED" && !session) {
      resetClientState();
      showView("auth");
    }
  });
}

boot();
