import { describe, it, expect } from "vitest";
import { estimateMonthlyCost, costFootnotes, AZURE_FREE_GRANT_NOTE } from "./pricing";

describe("estimateMonthlyCost", () => {
  it("defaults to pinecone when no vector store is passed", () => {
    const withDefault = estimateMonthlyCost("aws");
    const withExplicit = estimateMonthlyCost("aws", "pinecone");
    expect(withDefault).toEqual(withExplicit);
  });

  it("totals equal the sum of each line for aws/pinecone", () => {
    const est = estimateMonthlyCost("aws", "pinecone");
    const sumLow = est.lines.reduce((s, l) => s + l.lowUsd, 0);
    const sumHigh = est.lines.reduce((s, l) => s + l.highUsd, 0);
    expect(est.totalLow).toBe(Math.round(sumLow));
    expect(est.totalHigh).toBe(Math.round(sumHigh));
  });

  it("totals equal the sum of each line for azure/pgvector", () => {
    const est = estimateMonthlyCost("azure", "pgvector");
    const sumLow = est.lines.reduce((s, l) => s + l.lowUsd, 0);
    const sumHigh = est.lines.reduce((s, l) => s + l.highUsd, 0);
    expect(est.totalLow).toBe(Math.round(sumLow));
    expect(est.totalHigh).toBe(Math.round(sumHigh));
  });

  it("adds a dedicated pgvector line for aws and omits it for pinecone", () => {
    const withPgvector = estimateMonthlyCost("aws", "pgvector");
    const withPinecone = estimateMonthlyCost("aws", "pinecone");

    expect(withPgvector.lines.some((l) => l.label.includes("RDS PostgreSQL"))).toBe(true);
    expect(withPinecone.lines.some((l) => l.label.includes("RDS PostgreSQL"))).toBe(false);
    expect(withPgvector.lines.length).toBe(withPinecone.lines.length + 1);
  });

  it("adds a dedicated pgvector line for azure and omits it for pinecone", () => {
    const withPgvector = estimateMonthlyCost("azure", "pgvector");
    const withPinecone = estimateMonthlyCost("azure", "pinecone");

    expect(withPgvector.lines.some((l) => l.label.includes("Azure PostgreSQL"))).toBe(true);
    expect(withPinecone.lines.some((l) => l.label.includes("Azure PostgreSQL"))).toBe(false);
    expect(withPgvector.lines.length).toBe(withPinecone.lines.length + 1);
  });

  it("pgvector total is strictly higher than pinecone total for the same provider", () => {
    for (const provider of ["aws", "azure"] as const) {
      const pinecone = estimateMonthlyCost(provider, "pinecone");
      const pgvector = estimateMonthlyCost(provider, "pgvector");
      expect(pgvector.totalLow).toBeGreaterThan(pinecone.totalLow);
      expect(pgvector.totalHigh).toBeGreaterThan(pinecone.totalHigh);
    }
  });

  it("charges for two Secrets Manager secrets under pinecone and one under pgvector (aws)", () => {
    const pinecone = estimateMonthlyCost("aws", "pinecone");
    const pgvector = estimateMonthlyCost("aws", "pgvector");
    const secretsLine = (est: ReturnType<typeof estimateMonthlyCost>) =>
      est.lines.find((l) => l.label === "Secrets Manager")!;

    expect(secretsLine(pinecone).detail).toContain("2 secrets");
    expect(secretsLine(pgvector).detail).toContain("1 secret");
    expect(secretsLine(pinecone).lowUsd).toBeGreaterThan(secretsLine(pgvector).lowUsd);
  });

  it("all cost lines are non-negative", () => {
    for (const provider of ["aws", "azure"] as const) {
      for (const vectorStore of ["pinecone", "pgvector"] as const) {
        const est = estimateMonthlyCost(provider, vectorStore);
        for (const line of est.lines) {
          expect(line.lowUsd).toBeGreaterThanOrEqual(0);
          expect(line.highUsd).toBeGreaterThanOrEqual(line.lowUsd);
        }
      }
    }
  });
});

describe("costFootnotes", () => {
  it("mentions Pinecone billing separately when vector store is pinecone", () => {
    const notes = costFootnotes("pinecone");
    expect(notes.some((n) => n.includes("Pinecone is billed"))).toBe(true);
  });

  it("mentions the vector store running in-cloud when vector store is pgvector", () => {
    const notes = costFootnotes("pgvector");
    expect(notes.some((n) => n.includes("included above"))).toBe(true);
    expect(notes.some((n) => n.includes("Pinecone is billed"))).toBe(false);
  });

  it("defaults to pinecone footnotes when no argument is given", () => {
    expect(costFootnotes()).toEqual(costFootnotes("pinecone"));
  });
});

describe("AZURE_FREE_GRANT_NOTE", () => {
  it("is a non-empty descriptive string", () => {
    expect(typeof AZURE_FREE_GRANT_NOTE).toBe("string");
    expect(AZURE_FREE_GRANT_NOTE.length).toBeGreaterThan(0);
  });
});
