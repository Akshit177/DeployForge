document.querySelectorAll(".eye-toggle").forEach((toggleButton) => {
  toggleButton.addEventListener("click", () => {
    const target = document.getElementById(toggleButton.dataset.target || "password");
    if (!target) return;

    const showPassword = target.type === "password";
    target.type = showPassword ? "text" : "password";
    toggleButton.classList.toggle("active", showPassword);
  });
});

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const form = loginForm || registerForm;
const formMessage = document.getElementById("formMessage");

if (form && formMessage) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formMessage.textContent = "";
    formMessage.className = "form-message";

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;

    const isRegistration = form === registerForm;
    const payload = isRegistration
      ? {
          user_name: document.getElementById("fullName").value.trim(),
          email: document.getElementById("email").value.trim(),
          password: document.getElementById("password").value,
        }
      : {
          email: document.getElementById("email").value.trim(),
          password: document.getElementById("password").value,
        };

    if (
      isRegistration &&
      payload.password !== document.getElementById("confirmPassword").value
    ) {
      formMessage.textContent = "The passwords do not match.";
      formMessage.classList.add("error");
      submitButton.disabled = false;
      return;
    }

    try {
      const response = await fetch(
        `/api/auth/${isRegistration ? "register" : "login"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload),
        }
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || "The request could not be completed.");
      }

      formMessage.textContent = result.message;
      formMessage.classList.add("success");
      if (isRegistration) form.reset();
    } catch (error) {
      formMessage.textContent =
        error instanceof TypeError
          ? "Could not connect to the server. Open this page through the backend server and try again."
          : error.message;
      formMessage.classList.add("error");
    } finally {
      submitButton.disabled = false;
    }
  });
}
