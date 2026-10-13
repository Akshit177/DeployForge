export default function BrandLogo({ size = 28, showText = true, className = "" }) {
  return (
    <div className={`brand-lockup ${className}`} style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
      <div
        className="brand-sigil-wrap"
        style={{
          width: size,
          height: size,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 118 118"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M72.9902 41.3169C74.9673 40.8811 76.7294 42.6432 76.2936 44.6203L68.3353 80.7274C67.8641 82.8655 65.2166 83.6389 63.6685 82.0908L35.5197 53.942C33.9716 52.3939 34.745 49.7464 36.8831 49.2752L72.9902 41.3169Z"
            fill="currentColor"
          />
          <ellipse
            cx="49.7257"
            cy="68.1479"
            rx="11.1584"
            ry="13.0265"
            transform="rotate(45 49.7257 68.1479)"
            fill="currentColor"
          />
          <ellipse
            cx="49.7256"
            cy="68.1479"
            rx="5.5792"
            ry="6.51326"
            transform="rotate(45 49.7256 68.1479)"
            fill="#000000"
          />
        </svg>
      </div>
      {showText && (
        <span
          className="brand-text"
          style={{
            fontFamily: "Inter, -apple-system, sans-serif",
            fontWeight: 600,
            fontSize: size > 24 ? "18px" : "15px",
            letterSpacing: "-0.03em",
            color: "#ffffff",
          }}
        >
          DeployForge
        </span>
      )}
    </div>
  );
}
