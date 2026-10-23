import { describe, expect, it } from "vitest";

import { buildPatientFhirBundle } from "./fhir";

describe("FHIR patient bundle", () => {
  it("maps scheduling data to an R4 collection without notes", () => {
    const bundle = buildPatientFhirBundle({
      generatedAt: "2026-10-24T00:00:00.000Z",
      patient: { id: "patient-1", external_id: "MRN-7", first_name: "A", last_name: "Patient", date_of_birth: "2018-01-02", status: "ACTIVE" },
      services: [{ id: "service-1", service_code: "ABA", service_name: "ABA Direct" }],
      providers: [{ id: "provider-1", first_name: "P", last_name: "Clinician" }],
      locations: [{ id: "location-1", name: "North Clinic" }],
      authorizations: [{ id: "auth-1", service_id: "service-1", payer: "Example Plan", authorization_number: "AUTH-1", authorized_hours: 30, authorized_units: null, units_per_hour: 4, start_date: "2026-10-01", end_date: "2026-12-31", status: "ACTIVE" }],
      appointments: [{ id: "appointment-1", service_id: "service-1", provider_id: "provider-1", location_id: "location-1", start_time: "2026-10-24T14:00:00Z", end_time: "2026-10-24T15:00:00Z", status: "CONFIRMED", telehealth: false }],
    });
    expect(bundle).toMatchObject({ resourceType: "Bundle", type: "collection", total: 5 });
    expect(bundle.entry.map((entry) => entry.resource.resourceType)).toEqual([
      "Patient", "Practitioner", "Location", "Coverage", "Appointment",
    ]);
    expect(JSON.stringify(bundle)).not.toContain("notes");
  });
});
