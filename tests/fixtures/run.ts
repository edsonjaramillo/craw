import { adversarialScenario } from "./scenarios/adversarial";
import { startFixture } from "./server";

// Manual inspection only: bun run tests/fixtures/run.ts
if (import.meta.main) {
  const fixture = startFixture(adversarialScenario, { port: 3000 });
  console.log(`Fixture listening at ${fixture.url.href}`);
  const shutdown = async () => {
    await fixture.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
