import os
from pathlib import Path
import sys
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app
from app.models import OptimizationProblem
from app.solver import solve_problem


def problem() -> OptimizationProblem:
    return OptimizationProblem.model_validate({
        "version": 1,
        "goals": [
            {
                "service_id": "aba",
                "required": True,
                "priority": 1,
                "current_slots": 0,
                "minimum_slots": 4,
                "target_slots": 8,
                "addable_slots": 8,
                "current_sessions": 0,
                "minimum_sessions": 1,
                "target_sessions": 2,
                "addable_sessions": 2,
            },
            {
                "service_id": "ot",
                "required": True,
                "priority": 2,
                "current_slots": 0,
                "minimum_slots": 4,
                "target_slots": 4,
                "addable_slots": 4,
                "current_sessions": 0,
                "minimum_sessions": 1,
                "target_sessions": 1,
                "addable_sessions": 1,
            },
        ],
        "candidates": [
            {
                "candidate_id": "aba-morning",
                "service_id": "aba",
                "provider_id": "provider-a",
                "start_slot": 0,
                "end_slot": 4,
                "duration_slots": 4,
                "continuity": 1,
                "preferred": 0,
            },
            {
                "candidate_id": "aba-afternoon",
                "service_id": "aba",
                "provider_id": "provider-a",
                "start_slot": 8,
                "end_slot": 12,
                "duration_slots": 4,
                "continuity": 1,
                "preferred": 1,
            },
            {
                "candidate_id": "ot-middle",
                "service_id": "ot",
                "provider_id": "provider-b",
                "start_slot": 4,
                "end_slot": 8,
                "duration_slots": 4,
                "continuity": 0,
                "preferred": 1,
            },
        ],
        "authorization_limits": {},
        "incompatibilities": [],
        "strategies": ["BALANCED", "PREFERRED"],
        "max_solutions": 2,
        "time_limit_seconds": 4,
    })


class SolverTests(unittest.TestCase):
    def test_reaches_all_targets_without_overlap(self) -> None:
        result = solve_problem(problem())
        self.assertEqual(result.status, "OPTIMAL")
        self.assertTrue(result.plans)
        self.assertEqual(
            set(result.plans[0].candidate_ids),
            {"aba-morning", "aba-afternoon", "ot-middle"},
        )

    def test_incompatibility_blocks_an_otherwise_preferred_pair(self) -> None:
        payload = problem().model_dump()
        payload["incompatibilities"] = [{"left": 1, "right": 2}]
        result = solve_problem(OptimizationProblem.model_validate(payload))
        self.assertNotEqual(
            set(result.plans[0].candidate_ids),
            {"aba-morning", "aba-afternoon", "ot-middle"},
        )

    def test_endpoint_requires_constant_time_bearer_authentication(self) -> None:
        os.environ["CP_SAT_SOLVER_SECRET"] = "a-secure-solver-secret-value"
        client = TestClient(app)
        self.assertEqual(client.post("/v1/optimize", json=problem().model_dump()).status_code, 401)
        response = client.post(
            "/v1/optimize",
            json=problem().model_dump(),
            headers={"Authorization": "Bearer a-secure-solver-secret-value"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "OPTIMAL")

    def test_authorization_limit_is_aggregated_across_candidates(self) -> None:
        payload = problem().model_dump()
        payload["candidates"][0]["authorization_id"] = "auth-a"
        payload["candidates"][1]["authorization_id"] = "auth-a"
        payload["authorization_limits"] = {"auth-a": 4}
        result = solve_problem(OptimizationProblem.model_validate(payload))
        selected = set(result.plans[0].candidate_ids)
        self.assertLessEqual(len(selected & {"aba-morning", "aba-afternoon"}), 1)


if __name__ == "__main__":
    unittest.main()
