const API_BASE = process.env.API_BASE ?? "http://localhost:8000";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "dev-admin-password";

const assertOk = async (res, label) => {
  if (res.ok) return;
  const body = await res.text();
  const detail = body ? ` (${body})` : "";
  throw new Error(`${label} failed: ${res.status}${detail}`);
};

// Read-only: health, login, state, run inbox. It never starts a solver run
// (that would be a real, machine-exclusive CP-SAT run on the target system).
const run = async () => {
  const healthRes = await fetch(`${API_BASE}/health`);
  await assertOk(healthRes, "Health check");
  console.log("Health check ok.");

  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }),
  });
  await assertOk(loginRes, "Login");
  const loginData = await loginRes.json();
  const token = loginData?.access_token;
  if (!token) {
    throw new Error("Login failed: missing access token.");
  }
  console.log(`Login ok for ${loginData?.user?.username ?? ADMIN_USERNAME}.`);

  const stateRes = await fetch(`${API_BASE}/v1/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await assertOk(stateRes, "Get state");
  console.log("State fetch ok.");

  const runsRes = await fetch(`${API_BASE}/v1/solve/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await assertOk(runsRes, "List runs");
  const runsData = await runsRes.json();
  console.log(`Run inbox ok: ${runsData.runs?.length ?? 0} runs.`);
};

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
