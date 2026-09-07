/**
 * Redacts secret-shaped strings from text returned to the caller.
 * Patterns per the design requirements: Kiro keys (ksk_), GitHub tokens
 * (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_), AWS access keys + labeled secrets, JWTs.
 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "kiro-key", re: /ksk_[A-Za-z0-9_-]{8,}/g },
  { kind: "github-token", re: /gh[poushr]_[A-Za-z0-9]{16,}/g },
  { kind: "github-token", re: /github_pat_[A-Za-z0-9_]{16,}/g },
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Labeled AWS secret keys only: a bare 40-char base64 match has too many false positives.
  {
    kind: "aws-secret-access-key",
    re: /(aws_secret_access_key\s*[=:]\s*)["']?[A-Za-z0-9/+=]{30,}["']?/gi,
  },
  // Three dot-separated base64url segments, first two starting with eyJ ({"...).
  { kind: "jwt", re: /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g },
];

export function redact(text: string): string {
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (_match, ...rest) => {
      // The labeled-secret pattern keeps its label group so the reader sees what was cut.
      const label = typeof rest[0] === "string" ? rest[0] : "";
      return `${label}[REDACTED:${kind}]`;
    });
  }
  return out;
}
