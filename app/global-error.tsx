"use client";

export default function GlobalError({
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#eef1f4", color: "#0f1720" }}>
        <title>Temporary problem | Baker Street Scheduling</title>
        <main
          style={{
            alignItems: "center",
            display: "grid",
            fontFamily: "system-ui, sans-serif",
            minHeight: "100vh",
            padding: "24px",
            placeItems: "center",
          }}
        >
          <section
            role="alert"
            style={{
              background: "white",
              border: "1px solid #e6e9ed",
              borderRadius: "16px",
              boxSizing: "border-box",
              maxWidth: "512px",
              padding: "32px",
              textAlign: "center",
              width: "100%",
            }}
          >
            <h1 style={{ fontSize: "24px", margin: "0 0 12px" }}>
              We could not load the application
            </h1>
            <p style={{ color: "#566070", lineHeight: 1.5, margin: 0 }}>
              Your changes may not have been saved. Try again, and contact support
              if the problem continues.
            </p>
            <button
              onClick={() => retry()}
              style={{
                background: "#047857",
                border: 0,
                borderRadius: "8px",
                color: "white",
                cursor: "pointer",
                fontSize: "16px",
                fontWeight: 600,
                marginTop: "24px",
                padding: "10px 16px",
              }}
              type="button"
            >
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
