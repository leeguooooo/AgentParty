declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    ADMIN_SECRET: string;
    TEST_MIGRATIONS: D1Migration[];
    OIDC_ISSUER?: string;
    OIDC_CLIENT_ID?: string;
  }
}
