export const TARGETS = [
    "Patient.name.text",
    "Patient.birthDate",
    "Patient.gender",
    "Patient.identifier.value",
    "Condition.code.text",
    "MedicationStatement.medicationCodeableConcept.text",
    "Observation.code.text",
    "Observation.valueString",
] as const;