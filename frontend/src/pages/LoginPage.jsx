import { useState } from "react";
import AuthLayout from "../components/auth/AuthLayout.jsx";
import FormMessage from "../components/auth/FormMessage.jsx";
import PasswordInput from "../components/auth/PasswordInput.jsx";
import TextInput from "../components/auth/TextInput.jsx";
import useAuthForm from "../hooks/useAuthForm.js";
import { login } from "../services/authService.js";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { message, messageType, isSubmitting, submit } = useAuthForm();

  async function handleSubmit(event) {
    event.preventDefault();
    await submit(async () => {
      const result = await login({ email: email.trim(), password });
      return result.message;
    });
  }

  return (
    <AuthLayout
      title="Welcome to DeployForge"
      description="Sign in to manage and deploy your projects"
      footer={<>Don't have an account? <a href="/register">Create account</a></>}
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        <TextInput
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@domain.com"
          autoComplete="email"
        />
        <PasswordInput
          id="password"
          label="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="••••••••"
          autoComplete="current-password"
          forgotLink
        />
        <button type="submit" className="submit-btn" disabled={isSubmitting}>
          {isSubmitting ? "Please wait..." : "Sign In"}
        </button>
      </form>
      <FormMessage message={message} type={messageType} />
    </AuthLayout>
  );
}
