/**
 * Runtime configuration.
 *
 * Everything has a working default so `npm start` works with zero setup:
 * the DeepSeek vision route is used with a key resolved from (in order)
 * the process env, a DSH credential store, or a local `.env`.
 *
 * @module vision-qc-agent/config
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal YAML reader — handles exactly the flat two-level `refs:` shape DSH writes. */
function readCredentialRefs(path) {
  if (!existsSync(path)) return {};
  const refs = {};
  let inRefs = false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (/^\S/.test(line) && !/^refs:/.test(line)) inRefs = false;
    if (!inRefs) continue;
    const match = /^\s+([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    refs[match[1]] = value;
  }
  return refs;
}

/** Minimal `.env` reader: `KEY=value`, `#` comments, optional quotes. */
function readDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/** Candidate DSH homes, most specific first. */
function dshHomes() {
  const homes = [];
  if (process.env.DSH_HOME) homes.push(resolve(process.env.DSH_HOME));
  homes.push(join(homedir(), ".dsh"));
  return homes;
}

/**
 * Resolve one api key by name.
 * @param {string} name - credential reference name, e.g. `DEEPSEEK_API_KEY`.
 * @returns {{value: string|undefined, source: string}} the key and where it came from.
 */
export function resolveCredential(name) {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim().length > 0) {
    return { value: fromEnv.trim(), source: `env:${name}` };
  }
  for (const home of dshHomes()) {
    const refs = readCredentialRefs(join(home, ".credentials.yaml"));
    if (refs[name]) return { value: refs[name], source: "dsh:~/.dsh/.credentials.yaml" };
  }
  const dotenv = readDotEnv(join(APP_ROOT, ".env"));
  if (dotenv[name]) return { value: dotenv[name], source: `.env:${name}` };
  return { value: undefined, source: "missing" };
}

const DEFAULT_PROVIDER = "deepseek";

/**
 * Build the effective configuration.
 * Environment overrides: `QC_PROVIDER`, `QC_MODEL`, `QC_BASE_URL`, `QC_API_KEY_ENV`,
 * `QC_MOCK`, `QC_PORT`, `QC_MAX_IMAGES`.
 * @returns {object} frozen configuration object.
 */
export function loadConfig() {
  const provider = process.env.QC_PROVIDER || DEFAULT_PROVIDER;
  const mock = process.env.QC_MOCK === "1" || process.env.QC_MOCK === "true";

  /** @type {Record<string, {label: string, baseURL: string, api: string, keyEnv: string, model: string, models: string[]}>} */
  const providers = {
    deepseek: {
      label: "DeepSeek（官方视觉线路）",
      baseURL: "https://api.deepseek.com/v1",
      api: "openai-completions",
      keyEnv: "DEEPSEEK_API_KEY",
      model: "deepseek-v4-flash-vision-exp",
      models: ["deepseek-v4-flash-vision-exp", "deepseek-flash"],
    },
    openai: {
      label: "OpenAI",
      baseURL: "https://api.openai.com/v1",
      api: "openai-completions",
      keyEnv: "OPENAI_API_KEY",
      model: "gpt-4o-mini",
      models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    },
    anthropic: {
      label: "Anthropic",
      baseURL: "https://api.anthropic.com/v1",
      api: "anthropic-messages",
      keyEnv: "ANTHROPIC_API_KEY",
      model: "claude-3-5-sonnet-latest",
      models: ["claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest"],
    },
  };

  const active = providers[provider] ?? providers[DEFAULT_PROVIDER];
  const keyEnv = process.env.QC_API_KEY_ENV || active.keyEnv;
  const credential = resolveCredential(keyEnv);

  return Object.freeze({
    port: Number(process.env.QC_PORT || 4599),
    maxImages: Number(process.env.QC_MAX_IMAGES || 12),
    maxUploadBytes: Number(process.env.QC_MAX_UPLOAD_BYTES || 12 * 1024 * 1024),
    concurrency: Number(process.env.QC_CONCURRENCY || 3),
    provider,
    providers,
    mock,
    model: process.env.QC_MODEL || active.model,
    baseURL: process.env.QC_BASE_URL || active.baseURL,
    api: active.api,
    keyEnv,
    apiKey: credential.value,
    credentialSource: credential.source,
    apiKeyConfigured: Boolean(credential.value),
    requestTimeoutMs: Number(process.env.QC_TIMEOUT_MS || 120_000),
    appRoot: APP_ROOT,
  });
}

/** Human-readable configuration summary for the UI banner (never leaks the key). */
export function publicConfig(config) {
  return {
    provider: config.provider,
    providerLabel: config.providers[config.provider]?.label ?? config.provider,
    model: config.model,
    mock: config.mock,
    apiKeyEnv: config.keyEnv,
    apiKeyConfigured: config.apiKeyConfigured,
    credentialSource: config.credentialSource,
    availableProviders: Object.entries(config.providers).map(([id, value]) => ({
      id,
      label: value.label,
      keyEnv: value.keyEnv,
      models: value.models,
      configured: resolveCredential(value.keyEnv).value !== undefined,
    })),
  };
}
