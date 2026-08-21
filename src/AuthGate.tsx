import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { allowedEmailDomain, allowOtpSignups, supabase, supabaseConfigured } from "./supabase";

const GUIDE_SESSION_KEY = "collaborative-activity-guide-seen";

function GuideModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="guide-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      <div className="guide-heading"><div><p className="eyebrow">Quick guide</p><h2 id="guide-title">Create your PowerPoints in 3 steps</h2></div><button type="button" className="guide-close" aria-label="Close guide" onClick={onClose}>×</button></div>
      <div className="guide-visual">
        <img src="/collaborative-activity-user-guide.png" alt="Collaborative Activity Generator upload and generate areas" />
        <span className="guide-focus guide-focus-one" />
        <span className="guide-focus guide-focus-two" />
        <span className="guide-focus guide-focus-three" />
        <div className="guide-callout guide-callout-one"><strong>1</strong><span>Upload lecture materials</span></div>
        <div className="guide-callout guide-callout-two"><strong>2</strong><span>Upload syllabus</span></div>
        <div className="guide-callout guide-callout-three"><strong>3</strong><span>Generate PowerPoints</span></div>
      </div>
      <button type="button" className="guide-done" onClick={onClose}>Got it</button>
    </section>
  </div>;
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(Boolean(supabase));
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    const receiveSession = (nextSession: Session | null) => {
      setSession(nextSession);
      if (nextSession && window.sessionStorage.getItem(GUIDE_SESSION_KEY) !== "1") setShowGuide(true);
    };
    void supabase.auth.getSession().then(({ data }) => { receiveSession(data.session); setChecking(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => receiveSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  const closeGuide = () => {
    window.sessionStorage.setItem(GUIDE_SESSION_KEY, "1");
    setShowGuide(false);
  };

  const requestCode = async () => {
    if (!supabase) return;
    if (!email.trim().toLowerCase().endsWith(`@${allowedEmailDomain}`)) { setMessage(`Use your @${allowedEmailDomain} email address.`); return; }
    setBusy(true); setMessage("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: allowOtpSignups },
    });
    setBusy(false);
    if (error) setMessage(error.message);
    else { setCodeSent(true); setOtp(""); setMessage("A six-digit sign-in code has been sent to your email."); }
  };

  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    void requestCode();
  };

  const verifyCode = async (event: FormEvent) => {
    event.preventDefault(); if (!supabase) return;
    if (!/^\d{6}$/.test(otp)) { setMessage("Enter the complete six-digit code."); return; }
    setBusy(true); setMessage("");
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: otp, type: "email" });
    setBusy(false); if (error) setMessage(error.message);
  };

  if (checking) return <main className="auth-page"><div className="auth-card"><p>Checking your session…</p></div></main>;
  if (!supabaseConfigured) return <main className="auth-page"><div className="auth-card auth-setup"><p className="eyebrow">Setup required</p><h1>Connect Supabase</h1><p>Add <code>VITE_SUPABASE_URL</code>, <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> and <code>VITE_ALLOWED_EMAIL_DOMAIN</code> to the environment, then restart the app.</p></div></main>;
  if (!session) return <main className="auth-page"><section className="auth-card" aria-labelledby="login-title">
    <p className="eyebrow">Teacher sign in</p><h1 id="login-title">Collaborative Activity Generator</h1>
    <p className="auth-intro">Use the six-digit code sent to your email. No password is required.</p>
    {!codeSent ? <form onSubmit={sendCode}>
      <label htmlFor="login-email">Email address</label>
      <input id="login-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder={`teacher@${allowedEmailDomain}`} />
      <button className="auth-primary" disabled={busy} type="submit">{busy ? "Sending…" : "Send six-digit code"}</button>
    </form> : <form onSubmit={verifyCode}>
      <label htmlFor="login-otp">Six-digit code</label>
      <input id="login-otp" className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" />
      <button className="auth-primary" disabled={busy || otp.length !== 6} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
      <div className="auth-secondary"><button type="button" onClick={() => { setCodeSent(false); setOtp(""); setMessage(""); }}>Change email</button><button type="button" disabled={busy} onClick={() => void requestCode()}>Resend code</button></div>
    </form>}
    {message && <p className="auth-message" role="status">{message}</p>}
  </section></main>;

  return <><div className="session-bar"><span>Signed in as <strong>{session.user.email}</strong></span><button type="button" onClick={() => setShowGuide(true)}>Guide</button><button type="button" onClick={() => void supabase!.auth.signOut()}>Sign out</button></div>{children}{showGuide && <GuideModal onClose={closeGuide} />}</>;
}
