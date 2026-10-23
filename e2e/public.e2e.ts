import { expect, test } from "@playwright/test";

import { REQUIRED_SCHEMA_VERSION } from "../lib/deployment/verification";

test("landing page exposes the product tour and authentication entry point", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Every service a patient needs, scheduled together.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What it does today" })).toBeVisible();
});

test("public authentication pages connect without exposing protected data", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Work SSO" })).toHaveCount(0);
  await page.getByRole("link", { name: "Request access" }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole("heading", { level: 1, name: "Request access" })).toBeVisible();

  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole("heading", { level: 1, name: "Reset your password" })).toBeVisible();
});

test("an anonymous user is redirected away from protected pages", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
});

test("invalid credentials return a generic sign-in error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Work email").fill("unknown-user@bakerstreet.test");
  await page.getByLabel("Password").fill("not-the-right-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/login\?error=/);
  await expect(page.getByRole("status")).toHaveText("Email or password is incorrect.");
});

test("signup validation rejects mismatched passwords before account creation", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("E2E Validation User");
  await page.getByLabel("Work email").fill("e2e-validation@bakerstreet.test");
  await page.getByLabel("Requested role").selectOption("PROVIDER");
  await page.getByLabel("Password", { exact: true }).fill("validation-password-one");
  await page.getByLabel("Confirm password").fill("validation-password-two");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/signup\?error=/);
  await expect(page.getByRole("status")).toHaveText("Passwords do not match.");
});

test("health endpoint confirms the required linked schema", async ({ request }) => {
  const response = await request.get("/api/health");
  const body = (await response.json()) as {
    status?: string;
    auth?: string;
    database?: string;
    configuration?: string;
    schema_version?: string;
  };

  expect(response.status(), JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({
    status: "ok",
    auth: "available",
    database: "available",
    configuration: "available",
    schema_version: REQUIRED_SCHEMA_VERSION,
  });
});

test("operational alerts reject unauthenticated callers", async ({ request }) => {
  const response = await request.get("/api/operations/alerts");

  expect(response.status()).toBe(401);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.json()).toEqual({ ok: false, error: "Unauthorized." });
});

test("push delivery rejects unauthenticated callers", async ({ request }) => {
  const response = await request.get("/api/push/deliver");

  expect(response.status()).toBe(401);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.json()).toEqual({ ok: false, error: "Unauthorized." });
});

test("clinical integration exports reject anonymous callers", async ({ request }) => {
  for (const path of [
    "/api/integrations/claims/fhir",
    "/api/integrations/ehr/capability",
    "/api/integrations/ehr/patients/00000000-0000-0000-0000-000000000000/bundle",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required." });
  }
});

test("mobile installation assets expose only a safe offline shell", async ({ request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json() as {
    display?: string;
    start_url?: string;
    icons?: Array<{ src?: string; purpose?: string }>;
  };
  expect(manifest).toMatchObject({ display: "standalone", start_url: "/dashboard" });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/icons/app-icon-192.png" }),
    expect.objectContaining({ src: "/icons/app-icon-512.png" }),
    expect.objectContaining({ purpose: "maskable" }),
  ]));

  const workerResponse = await request.get("/sw.js");
  expect(workerResponse.status()).toBe(200);
  const worker = await workerResponse.text();
  expect(worker).toContain('fetch(request).catch(()=>caches.match("/offline"))');
  expect(worker).not.toContain("/patients/");
  expect(worker).not.toContain("/api/");

  for (const path of [
    "/icons/app-icon-192.png",
    "/icons/app-icon-512.png",
    "/icons/apple-touch-icon.png",
  ]) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
});

test("guardian portal states its activation boundary", async ({ page }) => {
  await page.goto("/portal/login");
  await expect(page.getByRole("heading", { level: 1, name: "Guardian portal" })).toBeVisible();
  await expect(page.getByText("Guardian access has not been activated by this organization.")).toBeVisible();
});

test("public responses enforce the browser security boundary", async ({ request }) => {
  const response = await request.get("/login");
  const headers = response.headers();

  expect(response.status()).toBe(200);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(headers["x-powered-by"]).toBeUndefined();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).toContain("object-src 'none'");
});
