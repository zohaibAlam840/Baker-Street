import {
  type DeploymentTarget,
  validateDeploymentEnvironment,
} from "../lib/deployment/environment";

const candidate = process.argv[2] ?? process.env.DEPLOYMENT_TARGET;
if (candidate !== "staging" && candidate !== "production") {
  console.error("Pass staging or production as the deployment target.");
  process.exit(1);
}

const target: DeploymentTarget = candidate;
const result = validateDeploymentEnvironment(process.env, target);
for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
if (result.errors.length > 0) {
  for (const error of result.errors) console.error(`Error: ${error}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  target,
  release: (process.env.RELEASE_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA)?.slice(0, 12),
  communications: process.env.COMMUNICATIONS_DELIVERY_ENABLED === "true" ? "live-configured" : "record-only",
}));
