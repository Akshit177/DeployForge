import { useState } from "react";

const CONNECTION_ERROR =
  "Could not connect to the server. Open this page through the backend server and try again.";

export default function useAuthForm() {
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function showError(error) {
    setMessage(error);
    setMessageType("error");
  }

  async function submit(action) {
    setMessage("");
    setMessageType("");
    setIsSubmitting(true);

    try {
      const successMessage = await action();
      setMessage(successMessage);
      setMessageType("success");
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unable to complete your request.";
      showError(error instanceof TypeError ? CONNECTION_ERROR : errorMessage);
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { message, messageType, isSubmitting, showError, submit };
}
