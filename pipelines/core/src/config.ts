function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  temporal: {
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  },
  get controlPlaneDatabaseUrl(): string {
    return requireEnv("CONTROL_PLANE_DATABASE_URL");
  },
  get openaiApiKey(): string {
    return requireEnv("OPENAI_API_KEY");
  },
};
