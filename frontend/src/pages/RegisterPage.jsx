import { useState } from "react";
import AuthLayout from "../components/auth/AuthLayout.jsx";
import FormMessage from "../components/auth/FormMessage.jsx";
import PasswordInput from "../components/auth/PasswordInput.jsx";
import TextInput from "../components/auth/TextInput.jsx";
import useAuthForm from "../hooks/useAuthForm.js";
import { register } from "../services/authService.js";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const { message, messageType, isSubmitting, showError, submit } = useAuthForm();

  async function handleSubmit(event) {
    event.preventDefault();

    if (password !== confirmPassword) {
      showError("The passwords do not match.");
      return;
    }

    const succeeded = await submit(async () => {
      const result = await register({
        user_name: name.trim(),
        email: email.trim(),
        password,
      });
      return result.message;
    });

    if (succeeded) {
      setName("");
      setEmail("");
      setPassword("");
      setConfirmPassword("");
      setAcceptedTerms(false);
    }
  }

  return (
    <AuthLayout
      isRegistration
      title="Create your account"
      description="Start deploying and managing infrastructure in minutes"
      footer={<>Already have an account? <a href="/">Sign In</a></>}
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        <TextInput
          id="fullName"
          label="Full Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Alex Walker"
          autoComplete="name"
        />
        <TextInput
          id="email"
          label="Work Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="alex@company.com"
          autoComplete="email"
        />
        <PasswordInput
          id="password"
          label="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          minLength={8}
        />
        <PasswordInput
          id="confirmPassword"
          label="Confirm Password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder="Re-enter password"
          autoComplete="new-password"
        />
        <div className="checkbox-row">
          <input
            type="checkbox"
            id="terms"
            checked={acceptedTerms}
            onChange={(event) => setAcceptedTerms(event.target.checked)}
            required
          />
          <label htmlFor="terms">
            I agree to the <a href="#" onClick={(event) => event.preventDefault()}>Terms of Service</a> and <a href="#" onClick={(event) => event.preventDefault()}>Privacy Policy</a>
          </label>
        </div>
        <button type="submit" className="submit-btn" disabled={isSubmitting}>
          {isSubmitting ? "Please wait..." : "Create Account"}
        </button>
      </form>
      <FormMessage message={message} type={messageType} />
    </AuthLayout>
  );
}
