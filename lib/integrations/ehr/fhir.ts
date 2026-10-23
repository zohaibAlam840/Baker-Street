interface PatientRow {
  id: string;
  external_id: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  status: string;
}

interface AuthorizationRow {
  id: string;
  service_id: string;
  payer: string | null;
  authorization_number: string | null;
  authorized_hours: number | null;
  authorized_units: number | null;
  units_per_hour: number;
  start_date: string;
  end_date: string;
  status: string;
}

interface AppointmentRow {
  id: string;
  service_id: string;
  provider_id: string | null;
  location_id: string | null;
  start_time: string;
  end_time: string;
  status: string;
  telehealth: boolean;
}

interface NamedRow { id: string; first_name: string; last_name: string }
interface ServiceRow { id: string; service_code: string; service_name: string }
interface LocationRow { id: string; name: string }

export interface PatientFhirInput {
  patient: PatientRow;
  authorizations: AuthorizationRow[];
  appointments: AppointmentRow[];
  services: ServiceRow[];
  providers: NamedRow[];
  locations: LocationRow[];
  generatedAt?: string;
}

const ref = (type: string, id: string) => ({ reference: `${type}/${id}` });

function appointmentStatus(status: string) {
  const values: Record<string, string> = {
    SCHEDULED: "booked",
    CONFIRMED: "booked",
    COMPLETED: "fulfilled",
    CANCELLED: "cancelled",
    NO_SHOW: "noshow",
    PENDING: "proposed",
  };
  return values[status] ?? "proposed";
}

export function buildPatientFhirBundle(input: PatientFhirInput) {
  const services = new Map(input.services.map((row) => [row.id, row]));
  const providers = new Map(input.providers.map((row) => [row.id, row]));
  const locations = new Map(input.locations.map((row) => [row.id, row]));
  const patient = {
    resourceType: "Patient",
    id: input.patient.id,
    active: input.patient.status === "ACTIVE",
    ...(input.patient.external_id ? { identifier: [{ system: "urn:baker-street:external-patient", value: input.patient.external_id }] } : {}),
    name: [{ use: "official", family: input.patient.last_name, given: [input.patient.first_name] }],
    ...(input.patient.date_of_birth ? { birthDate: input.patient.date_of_birth } : {}),
  };
  const practitionerResources = input.providers.map((provider) => ({
    resourceType: "Practitioner",
    id: provider.id,
    active: true,
    name: [{ family: provider.last_name, given: [provider.first_name] }],
  }));
  const locationResources = input.locations.map((location) => ({
    resourceType: "Location",
    id: location.id,
    name: location.name,
  }));
  const coverageResources = input.authorizations.map((authorization) => {
    const service = services.get(authorization.service_id);
    return {
      resourceType: "Coverage",
      id: authorization.id,
      status: authorization.status === "ACTIVE" ? "active" : "cancelled",
      beneficiary: ref("Patient", input.patient.id),
      period: { start: authorization.start_date, end: authorization.end_date },
      ...(authorization.authorization_number ? { identifier: [{ value: authorization.authorization_number }] } : {}),
      ...(authorization.payer ? { payor: [{ display: authorization.payer }] } : {}),
      class: [{
        type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/coverage-class", code: "plan" }] },
        value: service?.service_code ?? authorization.service_id,
        name: service?.service_name ?? "Authorized service",
      }],
      extension: [{
        url: "https://baker-street.example/fhir/StructureDefinition/authorized-capacity",
        valueString: authorization.authorized_hours != null
          ? `${authorization.authorized_hours} hours`
          : `${authorization.authorized_units ?? 0} units at ${authorization.units_per_hour} units/hour`,
      }],
    };
  });
  const appointmentResources = input.appointments.map((appointment) => {
    const service = services.get(appointment.service_id);
    const provider = appointment.provider_id ? providers.get(appointment.provider_id) : null;
    const location = appointment.location_id ? locations.get(appointment.location_id) : null;
    return {
      resourceType: "Appointment",
      id: appointment.id,
      status: appointmentStatus(appointment.status),
      serviceType: [{ coding: [{ system: "urn:baker-street:service", code: service?.service_code ?? appointment.service_id, display: service?.service_name }] }],
      start: appointment.start_time,
      end: appointment.end_time,
      appointmentType: { text: appointment.telehealth ? "Telehealth" : "In person" },
      participant: [
        { actor: ref("Patient", input.patient.id), status: "accepted" },
        ...(appointment.provider_id ? [{ actor: { ...ref("Practitioner", appointment.provider_id), display: provider ? `${provider.first_name} ${provider.last_name}` : undefined }, status: "accepted" }] : []),
        ...(appointment.location_id ? [{ actor: { ...ref("Location", appointment.location_id), display: location?.name }, status: "accepted" }] : []),
      ],
    };
  });
  const resources = [patient, ...practitionerResources, ...locationResources, ...coverageResources, ...appointmentResources];
  return {
    resourceType: "Bundle",
    type: "collection",
    timestamp: input.generatedAt ?? new Date().toISOString(),
    total: resources.length,
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${resource.id}`,
      resource,
    })),
  };
}
