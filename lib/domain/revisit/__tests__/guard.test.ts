import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { assertSimulationEnv, assertSimulationTarget, databaseNameOf, requireSimulationEnv, SimulationTargetError } from "../guard";

const baseEnv = {
  DATABASE_URL: "postgres://u:secret@h:5432/periplus_sim",
  SESSION_SECRET: "x".repeat(40),
  S3_ENDPOINT: "http://localhost:8333",
  S3_REGION: "us-east-1",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "secret",
  CONTACT_EMAIL: "ops@example.invalid",
};

describe("databaseNameOf", () => {
  it("reads the database name of a connection url", () => {
    expect(databaseNameOf("postgres://u:p@h:5432/periplus_sim")).toBe("periplus_sim");
    expect(databaseNameOf("postgresql://u:p@h/periplus_test?sslmode=disable")).toBe("periplus_test");
    expect(databaseNameOf("postgres://u:p@h:5432/")).toBe("");
  });

  it("refuses an unreadable url without echoing it", () => {
    expect(() => databaseNameOf("not a url with secret")).toThrow(SimulationTargetError);
    expect(() => databaseNameOf("not a url with secret")).not.toThrow(/secret/);
  });
});

describe("assertSimulationTarget", () => {
  it("assertSimulationTarget refuses periplus and accepts periplus_sim", () => {
    expect(() => assertSimulationTarget("postgres://u:secret@h:5432/periplus")).toThrow(/periplus/);
    expect(() => assertSimulationTarget("postgres://u:secret@h:5432/periplus")).not.toThrow(/secret/);
    expect(() => assertSimulationTarget("postgres://u:p@h/periplus_sim")).not.toThrow();
    expect(() => assertSimulationTarget("postgres://u:p@h/periplus_test")).not.toThrow();
  });

  it("refuses look-alikes of the simulation database", () => {
    for (const name of ["periplus_sim2", "periplus_simulation", "test", "periplus_test_copy"]) {
      expect(() => assertSimulationTarget(`postgres://u:p@h/${name}`)).toThrow(SimulationTargetError);
    }
  });
});

describe("assertSimulationEnv", () => {
  it("is a no-op without PERIPLUS_SIMULATION", () => {
    expect(assertSimulationEnv(parseEnv({ ...baseEnv, DATABASE_URL: "postgres://u:p@h/periplus" }))).toBeNull();
  });

  it("refuses the simulation database without PERIPLUS_SIMULATION, without the password", () => {
    const env = parseEnv({ ...baseEnv, DATABASE_URL: "postgres://u:secret@h:5432/periplus_sim" });
    expect(() => assertSimulationEnv(env)).toThrow(SimulationTargetError);
    expect(() => assertSimulationEnv(env)).toThrow(/periplus_sim.*PERIPLUS_SIMULATION/);
    expect(() => assertSimulationEnv(env)).not.toThrow(/secret/);
    // A test database stays usable without a simulation.
    expect(assertSimulationEnv(parseEnv({ ...baseEnv, DATABASE_URL: "postgres://u:p@h/periplus_test" }))).toBeNull();
  });

  it("refuses S3_WRITE_PREFIX without PERIPLUS_SIMULATION", () => {
    const env = parseEnv({ ...baseEnv, DATABASE_URL: "postgres://u:p@h/periplus", S3_WRITE_PREFIX: "sim/t1/" });
    expect(() => assertSimulationEnv(env)).toThrow(/S3_WRITE_PREFIX/);
  });

  it("the worker refuses to start a simulation without write prefix", () => {
    const env = parseEnv({ ...baseEnv, PERIPLUS_SIMULATION: "test/revisit/scenario.json" });
    expect(() => assertSimulationEnv(env)).toThrow(/S3_WRITE_PREFIX/);
  });

  it("refuses a simulation against the production database, in German and without the password", () => {
    const env = parseEnv({
      ...baseEnv,
      DATABASE_URL: "postgres://u:secret@h:5432/periplus",
      PERIPLUS_SIMULATION: "test/revisit/scenario.json",
      S3_WRITE_PREFIX: "sim/t1/",
    });
    expect(() => assertSimulationEnv(env)).toThrow(/Simulation.*„periplus“/);
    expect(() => assertSimulationEnv(env)).not.toThrow(/secret/);
  });

  it("returns the scenario path and prefix of a valid simulation", () => {
    const env = parseEnv({ ...baseEnv, PERIPLUS_SIMULATION: "test/revisit/scenario.json", S3_WRITE_PREFIX: "sim/t1/" });
    expect(assertSimulationEnv(env)).toEqual({ scenarioPath: "test/revisit/scenario.json", writePrefix: "sim/t1/", database: "periplus_sim" });
  });
});

describe("requireSimulationEnv", () => {
  it("refuses a sim CLI outside a simulation and names the CLI's own environment (ruling M7-G-R4)", () => {
    const real = parseEnv({ ...baseEnv, DATABASE_URL: "postgres://u:p@h/periplus" });
    expect(() => requireSimulationEnv(real, "sim:verify")).toThrow(SimulationTargetError);
    expect(() => requireSimulationEnv(real, "sim:verify")).toThrow(/^sim:verify läuft nur in einer Simulation: in der Umgebung dieses Aufrufs PERIPLUS_SIMULATION/);
    const sim = parseEnv({ ...baseEnv, DATABASE_URL: "postgres://u:p@h/periplus_sim", PERIPLUS_SIMULATION: "data/sim/s.json", S3_WRITE_PREFIX: "sim/x/" });
    expect(requireSimulationEnv(sim, "sim:verify")).toEqual({ scenarioPath: "data/sim/s.json", writePrefix: "sim/x/", database: "periplus_sim" });
  });
});
