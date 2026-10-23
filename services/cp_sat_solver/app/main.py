import hmac
import os

from fastapi import FastAPI, Header, HTTPException, status

from .models import OptimizationProblem, OptimizationResponse
from .solver import solve_problem


app = FastAPI(
    title="Baker Street CP-SAT Solver",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


def _authorized(authorization: str | None) -> bool:
    secret = os.environ.get("CP_SAT_SOLVER_SECRET", "")
    if len(secret) < 24 or not authorization:
        return False
    return hmac.compare_digest(authorization, f"Bearer {secret}")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "engine": "OR_TOOLS_CP_SAT", "contract": "1"}


@app.post("/v1/optimize", response_model=OptimizationResponse)
def optimize(
    problem: OptimizationProblem,
    authorization: str | None = Header(default=None),
) -> OptimizationResponse:
    if not _authorized(authorization):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
    return solve_problem(problem)
