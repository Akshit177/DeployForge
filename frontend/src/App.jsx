import { useEffect } from "react";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";

export default function App() {
  const isRegistration = window.location.pathname.replace(/\/+$/, "") === "/register";

  useEffect(() => {
    document.title = `DeployForge - ${isRegistration ? "Create Account" : "Sign In"}`;
  }, [isRegistration]);

  return isRegistration ? <RegisterPage /> : <LoginPage />;
}
