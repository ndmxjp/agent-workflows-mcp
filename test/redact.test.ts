import { describe, expect, test } from "bun:test";
import { redact } from "../src/redact.ts";

describe("redact", () => {
  test.each([
    ["kiro key", "key is ksk_abc123DEF456ghi789", "ksk_"],
    ["github classic PAT", "token ghp_ABCDEFghijkl0123456789mnopqrstuv", "ghp_"],
    ["github oauth token", "token gho_ABCDEFghijkl0123456789mnopqrstuv", "gho_"],
    ["github fine-grained PAT", "github_pat_11ABCDEFG0123456789_abcdef", "github_pat_"],
    ["aws access key id", "creds AKIAIOSFODNN7EXAMPLE end", "AKIA"],
    ["aws temp key id", "creds ASIAIOSFODNN7EXAMPLE end", "ASIA"],
    [
      "jwt",
      "bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P",
      "eyJ",
    ],
  ])("redacts %s", (_label, input, marker) => {
    const out = redact(input);
    expect(out).toContain("[REDACTED:");
    expect(out).not.toContain(marker);
  });

  // Built at runtime so the source contains no secret-shaped literal (commit scanners flag those).
  const fakeSecretValue = "Ab9/".repeat(10);

  test("keeps the aws_secret_access_key label but cuts the value", () => {
    const out = redact(`aws_secret_access_key = ${fakeSecretValue}`);
    expect(out).toMatch(/aws_secret_access_key\s*=\s*\[REDACTED:aws-secret-access-key\]/);
  });

  test("redacts PEM private-key blocks", () => {
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"Ab9/".repeat(16)}\n-----END OPENSSH PRIVATE KEY-----`;
    const out = redact(`found this in ~/.ssh/id_ed25519:\n${pem}\ndone`);
    expect(out).toContain("[REDACTED:private-key]");
    expect(out).not.toContain("BEGIN OPENSSH");
  });

  test("leaves ordinary text alone", () => {
    const text = "The ghost variable holds a plain string, nothing key-shaped.";
    expect(redact(text)).toBe(text);
  });

  test("does not redact a bare 40-char base64 string without an aws label", () => {
    const text = `hash: ${fakeSecretValue}`;
    expect(redact(text)).toBe(text);
  });
});
