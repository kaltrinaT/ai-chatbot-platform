import { describe, it, expect } from "vitest";
import {
  FIELDS_BY_STEP,
  REQUIRED_BY_STEP,
  REQUIRED_BY_CLOUD,
  stepForField,
  earliestStepForFields,
} from "./steps";

describe("stepForField", () => {
  it("finds the step that owns a step-1 field", () => {
    expect(stepForField("cloudProvider")).toBe(1);
  });

  it("finds the step that owns a shared step-2 field", () => {
    expect(stepForField("slug")).toBe(2);
  });

  it("finds the step that owns an AWS-only step-2 field", () => {
    expect(stepForField("deploymentRoleArn")).toBe(2);
  });

  it("finds the step that owns an Azure-only step-2 field", () => {
    expect(stepForField("azureClientSecret")).toBe(2);
  });

  it("finds the step that owns a step-3 field", () => {
    expect(stepForField("pineconeApiKey")).toBe(3);
  });

  it("returns null for a field that belongs to no step", () => {
    expect(stepForField("somethingThatDoesNotExist")).toBeNull();
  });
});

describe("earliestStepForFields", () => {
  it("returns the single step for one field", () => {
    expect(earliestStepForFields(["llmApiKey"])).toBe(3);
  });

  it("returns the earliest of several steps", () => {
    expect(earliestStepForFields(["llmApiKey", "slug", "cloudProvider"])).toBe(1);
  });

  it("ignores unrecognized fields mixed in with recognized ones", () => {
    expect(earliestStepForFields(["bogusField", "awsRegion"])).toBe(2);
  });

  it("falls back to step 1 for an empty field list", () => {
    expect(earliestStepForFields([])).toBe(1);
  });

  it("falls back to step 1 when every field is unrecognized", () => {
    expect(earliestStepForFields(["bogus1", "bogus2"])).toBe(1);
  });
});

describe("wizard step data invariants", () => {
  const allRegisteredFields = new Set(Object.values(FIELDS_BY_STEP).flat());

  it("registers every REQUIRED_BY_STEP field under some step in FIELDS_BY_STEP", () => {
    // If this ever fails, a required field would silently fall through
    // stepForField() as null, and a server-side rejection of that field could
    // never route the user back to a step where they can fix it.
    for (const fields of Object.values(REQUIRED_BY_STEP)) {
      for (const field of fields) {
        expect(allRegisteredFields.has(field)).toBe(true);
      }
    }
  });

  it("registers every REQUIRED_BY_CLOUD field under some step in FIELDS_BY_STEP", () => {
    for (const fields of Object.values(REQUIRED_BY_CLOUD)) {
      for (const field of fields) {
        expect(allRegisteredFields.has(field)).toBe(true);
      }
    }
  });
});
