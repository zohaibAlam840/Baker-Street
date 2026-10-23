from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


Identifier = Annotated[str, Field(min_length=1, max_length=500)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Strategy(StrEnum):
    BALANCED = "BALANCED"
    CONTINUITY = "CONTINUITY"
    FEWEST_VISITS = "FEWEST_VISITS"
    PREFERRED = "PREFERRED"
    EARLIEST = "EARLIEST"


class Goal(StrictModel):
    service_id: Identifier
    required: bool
    priority: Annotated[int, Field(ge=0, le=10_000)]
    current_slots: Annotated[int, Field(ge=0, le=100_000)]
    minimum_slots: Annotated[int, Field(ge=0, le=100_000)]
    target_slots: Annotated[int, Field(ge=0, le=100_000)]
    addable_slots: Annotated[int, Field(ge=0, le=100_000)]
    current_sessions: Annotated[int, Field(ge=0, le=10_000)]
    minimum_sessions: Annotated[int, Field(ge=0, le=10_000)]
    target_sessions: Annotated[int, Field(ge=0, le=10_000)]
    addable_sessions: Annotated[int, Field(ge=0, le=10_000)]


class Candidate(StrictModel):
    candidate_id: Identifier
    service_id: Identifier
    provider_id: Identifier
    authorization_id: Identifier | None = None
    start_slot: Annotated[int, Field(ge=0, le=100_000)]
    end_slot: Annotated[int, Field(gt=0, le=100_000)]
    duration_slots: Annotated[int, Field(gt=0, le=10_000)]
    continuity: Literal[0, 1]
    preferred: Literal[0, 1]

    @model_validator(mode="after")
    def validate_range(self) -> "Candidate":
        if self.end_slot - self.start_slot != self.duration_slots:
            raise ValueError("Candidate range and duration do not agree")
        return self


class Incompatibility(StrictModel):
    left: Annotated[int, Field(ge=0)]
    right: Annotated[int, Field(ge=0)]

    @model_validator(mode="after")
    def validate_pair(self) -> "Incompatibility":
        if self.left >= self.right:
            raise ValueError("Incompatibility indexes must be ordered and distinct")
        return self


class OptimizationProblem(StrictModel):
    version: Literal[1]
    goals: Annotated[list[Goal], Field(max_length=50)]
    candidates: Annotated[list[Candidate], Field(max_length=12_000)]
    authorization_limits: dict[Identifier, Annotated[int, Field(ge=0, le=100_000)]]
    incompatibilities: Annotated[list[Incompatibility], Field(max_length=500_000)] = Field(
        default_factory=list
    )
    strategies: Annotated[list[Strategy], Field(min_length=1, max_length=5)]
    max_solutions: Annotated[int, Field(ge=1, le=5)] = 5
    time_limit_seconds: Annotated[float, Field(ge=0.25, le=30)] = 8

    @model_validator(mode="after")
    def validate_references(self) -> "OptimizationProblem":
        service_ids = {goal.service_id for goal in self.goals}
        if len(service_ids) != len(self.goals):
            raise ValueError("Goal service IDs must be unique")
        candidate_ids = {candidate.candidate_id for candidate in self.candidates}
        if len(candidate_ids) != len(self.candidates):
            raise ValueError("Candidate IDs must be unique")
        if any(candidate.service_id not in service_ids for candidate in self.candidates):
            raise ValueError("Every candidate must reference a goal")
        if any(pair.right >= len(self.candidates) for pair in self.incompatibilities):
            raise ValueError("Incompatibility index is outside the candidate list")
        if len(set(self.strategies)) != len(self.strategies):
            raise ValueError("Strategies must be unique")
        return self


class SolverPlan(StrictModel):
    strategy: Strategy
    candidate_ids: list[Identifier]
    optimal: bool


class OptimizationResponse(StrictModel):
    version: Literal[1] = 1
    status: Literal["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"]
    plans: list[SolverPlan]
    runtime_ms: Annotated[int, Field(ge=0)]
    branches: Annotated[int, Field(ge=0)]
    conflicts: Annotated[int, Field(ge=0)]
