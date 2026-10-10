export default function FormMessage({ message, type }) {
  return (
    <p className={`form-message${type ? ` ${type}` : ""}`} role="status" aria-live="polite">
      {message}
    </p>
  );
}
