declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    ADMIN_SECRET: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
