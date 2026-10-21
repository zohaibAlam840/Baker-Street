import { describe, expect, it } from "vitest";

import {
  parseLocationConfiguration,
  parseResourceConfiguration,
  parseServiceConfiguration,
} from "./validation";

describe("configuration validation", () => {
  it("normalizes valid service configuration", () => {
    const result = parseServiceConfiguration({
      name: " Speech therapy ",
      code: " speech-1 ",
      department: " Allied Health ",
      durations: "60, 30, 60, 45",
      defaultDuration: "45",
      primaryObjective: "MAXIMIZE_SERVICE_HOURS",
      requiresAuthorization: true,
      inPersonAllowed: true,
      telehealthAllowed: true,
      groupAllowed: false,
      active: true,
      resourceIds: [
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        name: "Speech therapy",
        code: "SPEECH-1",
        department: "Allied Health",
        durations: [30, 45, 60],
        defaultDuration: 45,
        resourceIds: ["20000000-0000-4000-8000-000000000001"],
      }),
    });
  });

  it("requires the default duration to remain allowed", () => {
    const result = parseServiceConfiguration({
      name: "Speech therapy",
      code: "SLP",
      department: "Allied Health",
      durations: "30, 60",
      defaultDuration: "45",
      primaryObjective: "MAXIMIZE_SERVICE_HOURS",
      requiresAuthorization: false,
      inPersonAllowed: true,
      telehealthAllowed: false,
      groupAllowed: false,
      active: true,
      resourceIds: [],
    });

    expect(result).toEqual({ ok: false, error: "Default duration must be one of the allowed durations." });
  });

  it("rejects services with no delivery mode", () => {
    const result = parseServiceConfiguration({
      name: "Speech therapy",
      code: "SLP",
      department: "Allied Health",
      durations: "30",
      defaultDuration: "30",
      primaryObjective: "MAXIMIZE_SERVICE_HOURS",
      requiresAuthorization: false,
      inPersonAllowed: false,
      telehealthAllowed: false,
      groupAllowed: false,
      active: true,
      resourceIds: [],
    });

    expect(result).toEqual({ ok: false, error: "Allow at least one delivery mode: in person or telehealth." });
  });

  it("validates location timezones", () => {
    expect(parseLocationConfiguration({
      name: "Clinic",
      type: "CLINIC",
      city: "Boston",
      state: "MA",
      timezone: "Not/A_Timezone",
      active: true,
    })).toEqual({ ok: false, error: "Enter a valid IANA timezone, such as America/New_York." });
  });

  it("requires a positive whole-number resource capacity", () => {
    expect(parseResourceConfiguration({
      name: "Sensory room",
      resourceType: "ROOM",
      capacity: "1.5",
      locationId: "",
      active: true,
    })).toEqual({ ok: false, error: "Capacity must be a whole number between 1 and 10,000." });
  });
});
