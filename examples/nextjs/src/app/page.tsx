"use client";

import { useState } from "react";
import { authClient } from "../auth-client";

export default function HomePage() {
  const { data: session, isPending } = authClient.useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  if (isPending) return <p>Loading...</p>;

  // ── Signed in ──────────────────────────────────────────────
  if (session) {
    return (
      <div>
        <h1>Welcome, {session.user?.name || session.user?.email}</h1>
        <p>
          Signed in as <strong>{session.user?.email}</strong>
        </p>
        <p>Session expires: {new Date(session.session?.expiresAt).toLocaleString()}</p>
        <button
          style={styles.button}
          onClick={async () => {
            await authClient.signOut();
            window.location.reload();
          }}
        >
          Sign out
        </button>
      </div>
    );
  }

  // ── Sign-in form ───────────────────────────────────────────
  return (
    <div>
      <h1>DynamoDB + Better Auth</h1>
      <p>Minimal Next.js example. Sign up or sign in below.</p>

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage("");

          // Try sign-in first
          const signInRes = await authClient.signIn.email({
            email,
            password,
          });

          if (!signInRes.error) {
            window.location.reload();
            return;
          }

          // Sign-in failed — try sign-up
          const signUpRes = await authClient.signUp.email({
            email,
            password,
            name: email.split("@")[0],
          });

          if (signUpRes.error) {
            setMessage(signUpRes.error.message || "Something went wrong");
            return;
          }

          // Sign-up succeeded — sign in
          const retryRes = await authClient.signIn.email({
            email,
            password,
          });

          if (retryRes.error) {
            setMessage(retryRes.error.message || "Sign-up succeeded but sign-in failed");
            return;
          }

          window.location.reload();
        }}
      >
        <label style={styles.label}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={styles.input}
            required
          />
        </label>

        <label style={styles.label}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            minLength={8}
            style={styles.input}
            required
          />
        </label>

        <button type="submit" style={styles.button}>
          Sign in / Sign up
        </button>

        {message && <p style={styles.error}>{message}</p>}
      </form>

      <p style={styles.hint}>
        First visit: creates your account and signs you in.
        <br />
        Return visit: signs you in with the same credentials.
      </p>
    </div>
  );
}

// ── Inline styles ──────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  label: {
    display: "block",
    marginBottom: 12,
    fontWeight: 600,
  },
  input: {
    display: "block",
    width: "100%",
    padding: "8px 12px",
    marginTop: 4,
    fontSize: 16,
    border: "1px solid #ccc",
    borderRadius: 6,
    boxSizing: "border-box",
  },
  button: {
    marginTop: 12,
    padding: "10px 20px",
    fontSize: 16,
    fontWeight: 600,
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
  },
  error: {
    color: "#dc2626",
    marginTop: 12,
  },
  hint: {
    marginTop: 24,
    fontSize: 13,
    color: "#666",
  },
};
