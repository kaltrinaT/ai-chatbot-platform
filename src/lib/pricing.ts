/**
 * Static monthly cost estimates for a tenant's chatbot stack, in the
 * CUSTOMER's cloud account. Pure module (no env/IO) so it can render on both
 * server and client.
 *
 * Baseline list prices for us-east-1 (AWS) / East US (Azure), checked 2026-07.
 * Sizing mirrors what the platform actually deploys: the platform never
 * overrides the Terraform sizing defaults (AWS backend 1 vCPU / 2 GB,
 * frontend 0.25 vCPU / 0.5 GB; Azure backend 0.5 vCPU / 1 Gi, frontend
 * 0.25 vCPU / 0.5 Gi — see infra/terraform).
 */

export type CostLine = {
  label: string;
  detail: string;
  lowUsd: number;
  highUsd: number;
};

export type CostEstimate = {
  lines: CostLine[];
  totalLow: number;
  totalHigh: number;
};

const HOURS_PER_MONTH = 730;
const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;

// AWS Fargate (us-east-1)
const FARGATE_VCPU_HOUR = 0.04048;
const FARGATE_GB_HOUR = 0.004445;
const ALB_FIXED_HOUR = 0.0225;

// Azure Container Apps consumption plan (East US), active usage
const ACA_VCPU_SECOND = 0.000024;
const ACA_GIB_SECOND = 0.000003;

function fargateMonthly(vcpu: number, gb: number): number {
  return (vcpu * FARGATE_VCPU_HOUR + gb * FARGATE_GB_HOUR) * HOURS_PER_MONTH;
}

function acaMonthly(vcpu: number, gib: number): number {
  return (vcpu * ACA_VCPU_SECOND + gib * ACA_GIB_SECOND) * SECONDS_PER_MONTH;
}

const round = (n: number) => Math.round(n);

export type VectorStore = "pinecone" | "pgvector";

// Smallest burstable managed Postgres on each cloud, which is what the
// Terraform provisions for the pgvector option (db.t4g.micro / B1ms + 32 GB).
const RDS_T4G_MICRO_MONTHLY = 12;
const RDS_STORAGE_32GB_MONTHLY = 4;
const AZURE_PG_B1MS_MONTHLY = 13;
const AZURE_PG_STORAGE_32GB_MONTHLY = 4;

export function estimateMonthlyCost(
  provider: "aws" | "azure",
  vectorStore: VectorStore = "pinecone"
): CostEstimate {
  const lines: CostLine[] =
    provider === "aws"
      ? [
          {
            label: "ECS Fargate — backend",
            detail: "1 vCPU, 2 GB, 1 replica, 24/7",
            lowUsd: round(fargateMonthly(1, 2)),
            highUsd: round(fargateMonthly(1, 2)),
          },
          {
            label: "ECS Fargate — frontend",
            detail: "0.25 vCPU, 0.5 GB, 1 replica, 24/7",
            lowUsd: round(fargateMonthly(0.25, 0.5)),
            highUsd: round(fargateMonthly(0.25, 0.5)),
          },
          {
            label: "Application Load Balancer",
            detail: `Fixed $${round(ALB_FIXED_HOUR * HOURS_PER_MONTH)}/mo + LCU usage`,
            lowUsd: 18,
            highUsd: 22,
          },
          { label: "ECR", detail: "2 repos, ~500 MB images", lowUsd: 1, highUsd: 1 },
          {
            label: "Secrets Manager",
            detail:
              vectorStore === "pinecone"
                ? "2 secrets (LLM + Pinecone keys)"
                : "1 secret (LLM key)",
            lowUsd: vectorStore === "pinecone" ? 0.8 : 0.4,
            highUsd: vectorStore === "pinecone" ? 0.8 : 0.4,
          },
          { label: "S3 — docs bucket", detail: "Storage + requests, usage-based", lowUsd: 0.5, highUsd: 5 },
          { label: "CloudWatch Logs", detail: "14-day retention, light traffic", lowUsd: 1, highUsd: 3 },
        ]
      : [
          {
            label: "Container App — backend",
            detail: "0.5 vCPU, 1 Gi, always-on",
            lowUsd: round(acaMonthly(0.5, 1)),
            highUsd: round(acaMonthly(0.5, 1)),
          },
          {
            label: "Container App — frontend",
            detail: "0.25 vCPU, 0.5 Gi, always-on",
            lowUsd: round(acaMonthly(0.25, 0.5)),
            highUsd: round(acaMonthly(0.25, 0.5)),
          },
          { label: "Container Registry (Basic)", detail: "Image storage", lowUsd: 5, highUsd: 5 },
          { label: "Key Vault (Standard)", detail: "Secret operations", lowUsd: 0.5, highUsd: 0.5 },
          { label: "Storage Account (LRS)", detail: "Docs storage + transactions", lowUsd: 1, highUsd: 5 },
          { label: "Log Analytics", detail: "30-day retention, 5 GB/mo free", lowUsd: 0, highUsd: 5 },
        ];

  if (vectorStore === "pgvector") {
    lines.push(
      provider === "aws"
        ? {
            label: "RDS PostgreSQL + pgvector",
            detail: "db.t4g.micro, single-AZ, 32 GB gp3",
            lowUsd: RDS_T4G_MICRO_MONTHLY + RDS_STORAGE_32GB_MONTHLY,
            highUsd: RDS_T4G_MICRO_MONTHLY + RDS_STORAGE_32GB_MONTHLY,
          }
        : {
            label: "Azure PostgreSQL + pgvector",
            detail: "Flexible Server B1ms, 32 GB",
            lowUsd: AZURE_PG_B1MS_MONTHLY + AZURE_PG_STORAGE_32GB_MONTHLY,
            highUsd: AZURE_PG_B1MS_MONTHLY + AZURE_PG_STORAGE_32GB_MONTHLY,
          }
    );
  }

  return {
    lines,
    totalLow: round(lines.reduce((s, l) => s + l.lowUsd, 0)),
    totalHigh: round(lines.reduce((s, l) => s + l.highUsd, 0)),
  };
}

export function costFootnotes(vectorStore: VectorStore = "pinecone"): string[] {
  return [
    "Estimates at us-east-1 / East US list prices for idle-to-light traffic; other regions vary by up to ~20%.",
    vectorStore === "pinecone"
      ? "Pinecone is billed by the customer's own Pinecone account, and the LLM API by its provider — neither appears on the cloud bill above."
      : "The vector store is included above because it runs in the customer's own cloud. The LLM API is billed separately by its provider.",
    "Outbound data transfer is usage-based and not included.",
  ];
}

export const AZURE_FREE_GRANT_NOTE =
  "Each Azure subscription includes a monthly free grant of 180,000 vCPU-seconds and 360,000 GiB-seconds for Container Apps, which reduces the compute lines above (most significant with few tenants per subscription).";
