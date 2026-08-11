import type { ClineCoreStartConfig } from "@cline/sdk"

// SDK package types stay behind this adapter boundary so configuration drift
// is caught by TypeScript without leaking the SDK into product layers.
export type ClineSdkStartConfig = ClineCoreStartConfig
