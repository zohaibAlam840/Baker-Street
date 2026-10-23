import { expect, type Page, test } from "@playwright/test";

const password = process.env.TEST_USER_PASSWORD;
const linkedEnvironmentReady = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL
    && (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    && password,
);

interface RouteExpectation {
  path: string;
  heading: string;
  text?: string;
}

interface RoleScenario {
  role: string;
  email: string;
  dashboardHeading: "Overview" | "Oversight";
  visibleNavigation: string;
  hiddenNavigation: string;
  allowed: RouteExpectation[];
  denied: string;
}

const scenarios: RoleScenario[] = [
  {
    role: "Scheduler",
    email: "scheduler@bakerstreet.test",
    dashboardHeading: "Overview",
    visibleNavigation: "Planned time off",
    hiddenNavigation: "Configuration",
    allowed: [
      { path: "/patients", heading: "Patients" },
      { path: "/approvals", heading: "Compare complete plans" },
      { path: "/assistant", heading: "Assistant" },
      { path: "/time-off", heading: "Planned time off" },
      { path: "/reductions", heading: "Clinical reduction review" },
    ],
    denied: "/configuration/users",
  },
  {
    role: "Clinical supervisor",
    email: "clinical@bakerstreet.test",
    dashboardHeading: "Overview",
    visibleNavigation: "Reduction review",
    hiddenNavigation: "Configuration",
    allowed: [
      { path: "/clinical", heading: "Clinical requirements" },
      { path: "/reductions", heading: "Clinical reduction review" },
    ],
    denied: "/configuration/users",
  },
  {
    role: "Provider",
    email: "provider@bakerstreet.test",
    dashboardHeading: "Overview",
    visibleNavigation: "Planned time off",
    hiddenNavigation: "Authorizations",
    allowed: [
      { path: "/time-off", heading: "Planned time off" },
      { path: "/settings", heading: "Settings", text: "Install on this device" },
    ],
    denied: "/authorizations",
  },
  {
    role: "Authorization specialist",
    email: "authorization@bakerstreet.test",
    dashboardHeading: "Overview",
    visibleNavigation: "Authorizations",
    hiddenNavigation: "Clinical",
    allowed: [
      { path: "/authorizations", heading: "Authorizations" },
      { path: "/claims", heading: "Claim readiness" },
    ],
    denied: "/clinical",
  },
  {
    role: "Operations manager",
    email: "operations@bakerstreet.test",
    dashboardHeading: "Overview",
    visibleNavigation: "Capacity",
    hiddenNavigation: "Configuration",
    allowed: [{ path: "/capacity", heading: "Capacity" }],
    denied: "/configuration/users",
  },
  {
    role: "Administrator",
    email: "admin@bakerstreet.test",
    dashboardHeading: "Oversight",
    visibleNavigation: "Configuration",
    hiddenNavigation: "Schedules",
    allowed: [{ path: "/configuration/users", heading: "Users and roles" }],
    denied: "/schedule",
  },
  {
    role: "Compliance officer",
    email: "compliance@bakerstreet.test",
    dashboardHeading: "Oversight",
    visibleNavigation: "Audit log",
    hiddenNavigation: "Schedules",
    allowed: [{ path: "/audit", heading: "Audit log" }],
    denied: "/schedule",
  },
];

async function signIn(page: Page, scenario: RoleScenario) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(scenario.email);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { level: 1, name: scenario.dashboardHeading }),
  ).toBeVisible();
}

test.describe("linked seven-role access matrix", () => {
  test.skip(
    !linkedEnvironmentReady,
    "Set the Supabase URL, publishable key, and TEST_USER_PASSWORD to run linked role tests.",
  );
  test.describe.configure({ mode: "serial" });

  for (const scenario of scenarios) {
    test(`${scenario.role} can open only its expected workflow`, async ({ page }) => {
      await signIn(page, scenario);

      await expect(
        page.getByRole("link", { name: scenario.visibleNavigation, exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: scenario.hiddenNavigation, exact: true }),
      ).toHaveCount(0);

      for (const route of scenario.allowed) {
        await page.goto(route.path);
        await expect(page).toHaveURL(new RegExp(`${route.path.replaceAll("/", "\\/")}(?:\\?.*)?$`));
        await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
        if (route.text) await expect(page.getByText(route.text)).toBeVisible();
      }

      if (scenario.role === "Authorization specialist") {
        const claimExport = await page.request.get("/api/integrations/claims/fhir");
        expect(claimExport.status()).toBe(200);
        expect(claimExport.headers()["content-type"]).toContain("application/fhir+json");
        expect(await claimExport.json()).toMatchObject({ resourceType: "Bundle", type: "collection" });
      }

      if (scenario.role === "Scheduler") {
        await page.goto("/patients");
        const patientHref = await page
          .locator('a[href^="/patients/"]:not([href="/patients/new"])')
          .first()
          .getAttribute("href");
        expect(patientHref).toMatch(/^\/patients\/[0-9a-f-]+$/);
        const patientExport = await page.request.get(`/api/integrations/ehr${patientHref}/bundle`);
        expect(patientExport.status()).toBe(200);
        expect(patientExport.headers()["content-type"]).toContain("application/fhir+json");
        expect(await patientExport.json()).toMatchObject({ resourceType: "Bundle", type: "collection" });
      }

      if (scenario.role === "Provider") {
        await page.goto("/settings");
        await expect(page.getByRole("heading", { level: 2, name: "Mobile push notifications" })).toBeVisible();
      }

      if (scenario.role === "Administrator") {
        const capability = await page.request.get("/api/integrations/ehr/capability");
        expect(capability.status()).toBe(200);
        expect(await capability.json()).toEqual({ status: "unconfigured" });
      }

      await page.goto(scenario.denied);
      await expect(page).toHaveURL(/\/no-access(?:\?|$)/);
      await expect(
        page.getByRole("heading", { level: 1, name: "That page is not part of your role" }),
      ).toBeVisible();
    });
  }
});
