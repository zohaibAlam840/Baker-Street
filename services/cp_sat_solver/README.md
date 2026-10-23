# CP-SAT optimizer service

This private service solves one prevalidated patient-week candidate set with
Google OR-Tools CP-SAT. It receives no patient name, contact detail, diagnosis,
free text, or database credentials. The application sends one-way candidate
tokens, opaque service/provider/authorization IDs, and integer slot constraints.

The service never writes schedules. Next.js re-proves every returned candidate
with the shared TypeScript rule engine, and a human approval still recomputes
the stable plan before the existing atomic Postgres commit.

## Run locally

```powershell
py -m venv .venv
.venv\Scripts\python.exe -m pip install --requirement requirements.txt
$env:CP_SAT_SOLVER_SECRET='replace-with-at-least-24-random-characters'
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8080
```

Run tests from this directory:

```powershell
.venv\Scripts\python.exe -m unittest discover -s tests -v
```

For containers:

```powershell
docker build -t baker-street-cp-sat .
docker run --rm -p 8080:8080 `
  -e CP_SAT_SOLVER_SECRET='replace-with-at-least-24-random-characters' `
  baker-street-cp-sat
```

Production must place the service behind HTTPS with private ingress where
available. Use the same server-only secret in the application and solver
environments, rotate it through the approved secret manager, and never expose
it through a `NEXT_PUBLIC_` variable.
