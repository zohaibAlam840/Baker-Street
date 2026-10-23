from __future__ import annotations

from dataclasses import dataclass
from time import monotonic

from ortools.sat.python import cp_model

from .models import OptimizationProblem, OptimizationResponse, SolverPlan, Strategy


@dataclass
class ModelState:
    model: cp_model.CpModel
    selected: list[cp_model.IntVar]
    criteria: dict[str, cp_model.LinearExprT]


def _build_model(problem: OptimizationProblem) -> ModelState:
    model = cp_model.CpModel()
    selected = [
        model.new_bool_var(f"candidate_{index}")
        for index in range(len(problem.candidates))
    ]
    intervals = [
        model.new_optional_interval_var(
            candidate.start_slot,
            candidate.duration_slots,
            candidate.end_slot,
            selected[index],
            f"interval_{index}",
        )
        for index, candidate in enumerate(problem.candidates)
    ]
    if intervals:
        # Every candidate belongs to the same patient-week request.
        model.add_no_overlap(intervals)

    for pair in problem.incompatibilities:
        model.add(selected[pair.left] + selected[pair.right] <= 1)

    by_service: dict[str, list[int]] = {}
    by_authorization: dict[str, list[int]] = {}
    for index, candidate in enumerate(problem.candidates):
        by_service.setdefault(candidate.service_id, []).append(index)
        if candidate.authorization_id:
            by_authorization.setdefault(candidate.authorization_id, []).append(index)

    required_met: list[cp_model.IntVar] = []
    targets_met: list[cp_model.IntVar] = []
    minimum_coverage: list[cp_model.LinearExprT] = []
    target_coverage: list[cp_model.LinearExprT] = []
    for goal_index, goal in enumerate(problem.goals):
        indexes = by_service.get(goal.service_id, [])
        added_slots = sum(
            problem.candidates[index].duration_slots * selected[index]
            for index in indexes
        )
        added_sessions = sum(selected[index] for index in indexes)
        model.add(added_slots <= goal.addable_slots)
        model.add(added_sessions <= goal.addable_sessions)

        projected_slots = goal.current_slots + added_slots
        projected_sessions = goal.current_sessions + added_sessions
        minimum_met = model.new_bool_var(f"minimum_met_{goal_index}")
        model.add(projected_slots >= goal.minimum_slots).only_enforce_if(minimum_met)
        model.add(projected_sessions >= goal.minimum_sessions).only_enforce_if(minimum_met)
        if goal.required:
            required_met.append(minimum_met)

        target_met = model.new_bool_var(f"target_met_{goal_index}")
        model.add(projected_slots >= goal.target_slots).only_enforce_if(target_met)
        model.add(projected_sessions >= goal.target_sessions).only_enforce_if(target_met)
        targets_met.append(target_met)

        priority_weight = max(1, 201 - min(200, goal.priority))
        minimum_cap = max(1, goal.minimum_slots)
        minimum_value = model.new_int_var(0, minimum_cap, f"minimum_coverage_{goal_index}")
        model.add_min_equality(minimum_value, [projected_slots, minimum_cap])
        minimum_coverage.append(minimum_value * priority_weight)

        target_cap = max(1, goal.target_slots)
        target_value = model.new_int_var(0, target_cap, f"target_coverage_{goal_index}")
        model.add_min_equality(target_value, [projected_slots, target_cap])
        target_coverage.append(target_value * priority_weight)

    for authorization_id, limit in problem.authorization_limits.items():
        indexes = by_authorization.get(authorization_id, [])
        model.add(sum(
            problem.candidates[index].duration_slots * selected[index]
            for index in indexes
        ) <= limit)

    total_slots = sum(
        candidate.duration_slots * selected[index]
        for index, candidate in enumerate(problem.candidates)
    )
    continuity = sum(
        candidate.continuity * selected[index]
        for index, candidate in enumerate(problem.candidates)
    )
    preferred = sum(
        candidate.preferred * selected[index]
        for index, candidate in enumerate(problem.candidates)
    )
    visit_count = sum(selected)
    start_sum = sum(
        candidate.start_slot * selected[index]
        for index, candidate in enumerate(problem.candidates)
    )
    return ModelState(
        model=model,
        selected=selected,
        criteria={
            "required_met": sum(required_met),
            "minimum_coverage": sum(minimum_coverage),
            "targets_met": sum(targets_met),
            "target_coverage": sum(target_coverage),
            "total_slots": total_slots,
            "continuity": continuity,
            "preferred": preferred,
            "fewest_visits": -visit_count,
            "earliest": -start_sum,
        },
    )


def _criterion_order(strategy: Strategy) -> list[str]:
    clinical = ["required_met", "minimum_coverage", "targets_met", "target_coverage"]
    if strategy == Strategy.CONTINUITY:
        return clinical + ["continuity", "total_slots", "preferred", "fewest_visits", "earliest"]
    if strategy == Strategy.FEWEST_VISITS:
        return clinical + ["total_slots", "fewest_visits", "continuity", "preferred", "earliest"]
    if strategy == Strategy.PREFERRED:
        return clinical + ["preferred", "continuity", "total_slots", "fewest_visits", "earliest"]
    if strategy == Strategy.EARLIEST:
        return clinical + ["total_slots", "earliest", "continuity", "preferred", "fewest_visits"]
    return clinical + ["total_slots", "continuity", "preferred", "fewest_visits", "earliest"]


def _solve_strategy(
    problem: OptimizationProblem,
    strategy: Strategy,
    budget_seconds: float,
) -> tuple[SolverPlan | None, int, int, str]:
    state = _build_model(problem)
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.log_search_progress = False
    deadline = monotonic() + budget_seconds
    order = _criterion_order(strategy)
    last_status = cp_model.UNKNOWN
    all_optimal = True

    for criterion_index, name in enumerate(order):
        remaining = deadline - monotonic()
        if remaining <= 0:
            all_optimal = False
            break
        stages_left = len(order) - criterion_index
        solver.parameters.max_time_in_seconds = max(0.01, remaining / stages_left)
        expression = state.criteria[name]
        state.model.maximize(expression)
        last_status = solver.solve(state.model)
        if last_status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None, solver.num_branches, solver.num_conflicts, solver.status_name(last_status)
        if last_status != cp_model.OPTIMAL:
            all_optimal = False
            break
        optimum = int(round(solver.objective_value))
        state.model.add(expression == optimum)

    if last_status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None, solver.num_branches, solver.num_conflicts, solver.status_name(last_status)
    candidate_ids = sorted(
        problem.candidates[index].candidate_id
        for index, variable in enumerate(state.selected)
        if solver.boolean_value(variable)
    )
    return (
        SolverPlan(strategy=strategy, candidate_ids=candidate_ids, optimal=all_optimal),
        solver.num_branches,
        solver.num_conflicts,
        "OPTIMAL" if all_optimal else "FEASIBLE",
    )


def solve_problem(problem: OptimizationProblem) -> OptimizationResponse:
    started = monotonic()
    strategies = problem.strategies[: problem.max_solutions]
    per_strategy_budget = problem.time_limit_seconds / max(1, len(strategies))
    plans: list[SolverPlan] = []
    seen: set[tuple[str, ...]] = set()
    branches = 0
    conflicts = 0
    statuses: list[str] = []

    for strategy in strategies:
        plan, plan_branches, plan_conflicts, status = _solve_strategy(
            problem,
            strategy,
            per_strategy_budget,
        )
        branches += plan_branches
        conflicts += plan_conflicts
        statuses.append(status)
        if plan is None:
            continue
        signature = tuple(plan.candidate_ids)
        if signature in seen:
            continue
        seen.add(signature)
        plans.append(plan)

    if plans and all(plan.optimal for plan in plans) and all(status == "OPTIMAL" for status in statuses):
        status = "OPTIMAL"
    elif plans:
        status = "FEASIBLE"
    elif statuses and all(value == "INFEASIBLE" for value in statuses):
        status = "INFEASIBLE"
    else:
        status = "UNKNOWN"

    return OptimizationResponse(
        status=status,
        plans=plans,
        runtime_ms=max(0, round((monotonic() - started) * 1000)),
        branches=branches,
        conflicts=conflicts,
    )
